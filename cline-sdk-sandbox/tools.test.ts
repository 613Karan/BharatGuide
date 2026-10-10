/**
 * Layer 1: tool isolation tests. No model, no network, no API key.
 *
 * Run: npm test   (from cline-sdk-sandbox)  ->  node --test tools.test.ts
 *
 * These tests answer "does the tool do the right thing when it is called?".
 * They do NOT answer "does the model call the right tool?" - that is Layer 3
 * (agent.live.test.ts). Keeping the two apart is the whole point: a failing
 * live test is ambiguous, a failing isolation test is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clickInput,
  createGhostTools,
  finishInput,
  pointAtInput,
  scrollInput,
} from './tools.ts';

/** Minimum fake AgentToolContext the SDK passes to execute(). */
const context = {
  agentId: 'test-agent',
  conversationId: 'test-conversation',
  iteration: 1,
};

test('each tool advertises a model-friendly contract', () => {
  const { tools } = createGhostTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['point_at', 'click', 'scroll', 'finish'],
  );

  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} must be snake_case`);
    assert.ok(
      tool.description.length >= 40,
      `${tool.name} needs a description long enough for the model to choose it`,
    );
    assert.equal(typeof tool.inputSchema, 'object', `${tool.name} must expose inputSchema`);
  }
});

test('input schemas reject exactly what guardrails would reject', () => {
  // Required field missing.
  assert.equal(pointAtInput.safeParse({}).success, false);
  // Enum keeps the model inside the allowed set.
  assert.equal(scrollInput.safeParse({ direction: 'sideways' }).success, false);
  assert.equal(scrollInput.safeParse({ direction: 'down' }).success, true);
  // Numeric bounds.
  assert.equal(scrollInput.safeParse({ direction: 'down', amount: 0 }).success, false);
  assert.equal(scrollInput.safeParse({ direction: 'down', amount: 2.5 }).success, false);
  // Optional field may be omitted.
  assert.equal(pointAtInput.safeParse({ element_id: 'e1' }).success, true);
  assert.equal(clickInput.safeParse({ element_id: 'e1' }).success, true);
  assert.equal(finishInput.safeParse({ message: 'done' }).success, true);
});

test('point_at returns a structured, non-empty result and records the call', async () => {
  const { tools, calls } = createGhostTools();
  const pointAt = tools.find((tool) => tool.name === 'point_at')!;

  const result = await pointAt.execute({ element_id: 'e12', hint: 'Search' }, context as never);

  assert.deepEqual(result, { ok: true, pointed: 'e12', hint: 'Search' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, 'point_at');
});

test('a tool that fills in defaults stays schema-valid', async () => {
  const { tools } = createGhostTools();
  const pointAt = tools.find((tool) => tool.name === 'point_at')!;

  const result = await pointAt.execute({ element_id: 'e3' }, context as never);

  assert.deepEqual(result, { ok: true, pointed: 'e3', hint: 'Look here' });
});

test('scroll reports the direction it was asked for', async () => {
  const { tools } = createGhostTools();
  const scroll = tools.find((tool) => tool.name === 'scroll')!;

  assert.deepEqual(await scroll.execute({ direction: 'bottom' }, context as never), {
    ok: true,
    direction: 'bottom',
    amount: 1,
  });
  assert.deepEqual(await scroll.execute({ direction: 'down', amount: 400 }, context as never), {
    ok: true,
    direction: 'down',
    amount: 400,
  });
});

test('finish is declared as a completion tool', () => {
  const { tools } = createGhostTools();
  const finish = tools.find((tool) => tool.name === 'finish') as
    | { lifecycle?: { completesRun?: boolean } }
    | undefined;

  assert.ok(finish, 'finish tool exists');
  assert.equal(
    finish.lifecycle?.completesRun,
    true,
    'without lifecycle.completesRun the loop runs until maxIterations',
  );
});
