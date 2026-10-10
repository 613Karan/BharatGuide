/**
 * Discovery helper: print the exact event union and payloads YOUR SDK version emits.
 *
 * The docs describe event surfaces in prose; the concrete `type` strings are the
 * thing you assert on, so read them off a real run instead of guessing.
 *
 *   $env:CLINE_API_KEY="<your key>"
 *   node dump-events.ts "Show me where the search box is, then finish."
 */
import { Agent } from '@cline/sdk';
import { createGhostTools } from './tools.ts';

const prompt = process.argv[2] ?? 'Show me where the search box is, then finish.';
const { tools, calls } = createGhostTools();

const agent = new Agent({
  providerId: process.env.PROVIDER_ID ?? 'openai-compatible',
  modelId: process.env.MODEL_ID ?? 'gpt-4o-mini',
  apiKey: process.env.PROVIDER_API_KEY,
  baseUrl: process.env.PROVIDER_BASE_URL,
  systemPrompt: 'You are a browsing guide. Show the user where elements are, then call finish.',
  tools,
  maxIterations: 4,
});

const seen = new Map<string, unknown>();
agent.subscribe((event) => {
  const record = event as Record<string, unknown>;
  seen.set(String(record['type']), record);
  const toolCall = record['toolCall'] as { toolName?: string } | undefined;
  console.log(
    `event: ${String(record['type'])}${toolCall?.toolName ? ` (${toolCall.toolName})` : ''}`,
  );
});

const result = await agent.run(prompt);

console.log('\n--- summary ---');
console.log('status      :', result.status);
console.log('iterations  :', result.iterations);
console.log('outputText  :', result.outputText);
console.log('usage       :', JSON.stringify(result.usage));
console.log('tools ran   :', JSON.stringify(calls, null, 2));
console.log('event types :', [...seen.keys()].join(', '));
console.log('\nfull payload of the last event of each type:');
for (const [type, payload] of seen) {
  console.log(`\n[${type}]\n${JSON.stringify(payload, null, 2)}`);
}
