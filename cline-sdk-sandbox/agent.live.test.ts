/**
 * Layer 3: real model, real tool calling. This is the only layer that answers
 * "does the MODEL pick the right tool with the right arguments?".
 *
 * Skipped by default because it needs a real model. Opt in (Cline only):
 *
 *   $env:CLINE_SDK_LIVE="1"
 *   $env:CLINE_API_KEY="<key from app.cline.bot > Settings > API Keys>"
 *   npm run test:live
 *
 * Provider defaults (all Cline, all pointing at https://api.cline.bot/api/v1):
 *   - "cline"       -> Cline (usage-billing)          <- default
 *   - "cline-pass"  -> ClinePass subscription models
 *   - "openai-compatible" + baseUrl -> same endpoint via the plain OpenAI path
 *
 * Free models exist (e.g. cline-free/mimo-v2.6-flash); set MODEL_ID to use one.
 *
 * Design note: assert on TOOL CALLS, never on prose. Model text is non-deterministic;
 * the tool call it emits is the thing you are actually testing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '@cline/sdk';
import { createGhostTools, pointAtInput } from './tools.ts';

const LIVE = process.env.CLINE_SDK_LIVE === '1';
const SKIP = !LIVE && 'set CLINE_SDK_LIVE=1 and CLINE_API_KEY to run';

/**
 * Cline-only provider config. The SDK ships the Cline providers natively and they
 * already default to https://api.cline.bot/api/v1, so we only override the base URL
 * when a caller explicitly asks for it.
 */
const providerId = process.env.PROVIDER_ID ?? 'cline';
const modelId = process.env.MODEL_ID ?? 'anthropic/claude-sonnet-4-6';
const apiKey = process.env.CLINE_API_KEY ?? process.env.PROVIDER_API_KEY;

function providerConfig(): {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
} {
  return { providerId, modelId, apiKey, baseUrl: process.env.PROVIDER_BASE_URL };
}

function makeAgent() {
  const { tools, calls } = createGhostTools();
  const agent = new Agent({
    ...providerConfig(),
    systemPrompt:
      'You are a browsing guide. To show the user where an element is, call point_at ' +
      'with that element id. Never click unless the user explicitly asks. When the goal ' +
      'is met, call finish with one short sentence.',
    tools,
    maxIterations: 4,
  });

  const toolNames: string[] = [];
  const eventTypes: string[] = [];
  agent.subscribe((event) => {
    eventTypes.push(event.type);
    if (event.type === 'tool-started') {
      toolNames.push((event as { toolCall: { toolName: string } }).toolCall.toolName);
    }
  });

  return { agent, calls, toolNames, eventTypes };
}

test('model chooses point_at and stays inside the schema', { skip: SKIP }, async () => {
  const { agent, calls, toolNames, eventTypes } = makeAgent();

  const result = await agent.run(
    'The page snapshot has element e7 which is the search box. Show me where it is.',
  );

  assert.equal(result.status, 'completed', `events: ${eventTypes.join(', ')}`);
  assert.ok(
    toolNames.includes('point_at'),
    `expected point_at, got: [${toolNames.join(', ')}]. events: ${eventTypes.join(', ')}`,
  );

  const call = calls.find((entry) => entry.tool === 'point_at');
  assert.ok(call, 'point_at execute() must have run');
  assert.equal(
    pointAtInput.safeParse(call!.input).success,
    true,
    `model produced schema-invalid arguments: ${JSON.stringify(call!.input)}`,
  );
});

test('model does not click when only guidance was requested', { skip: SKIP }, async () => {
  const { agent, calls, eventTypes } = makeAgent();

  await agent.run('Where is the search box? Just show me, do not click anything.');

  assert.equal(
    calls.some((entry) => entry.tool === 'click'),
    false,
    `model clicked despite being told not to. events: ${eventTypes.join(', ')} calls: ${JSON.stringify(calls)}`,
  );
});

test('a disabled tool is never visible to the model', { skip: SKIP }, async () => {
  const { tools, calls } = createGhostTools();
  const agent = new Agent({
    ...providerConfig(),
    systemPrompt: 'You are a browsing guide. Show the user where elements are.',
    tools,
    maxIterations: 4,
    toolPolicies: { click: { enabled: false } },
  });

  await agent.run('Find the search box and show me where it is.');

  assert.equal(
    calls.some((entry) => entry.tool === 'click'),
    false,
    `click was disabled by policy but still ran: ${JSON.stringify(calls)}`,
  );
});
