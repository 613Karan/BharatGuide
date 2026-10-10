// Spike (spec 8.7): does the Cline SDK drive tool calls on the local Ollama model?
// Run: node scripts/ollama-spike.mjs   (Ollama must be running)
import { Agent, createTool } from '@cline/sdk';

const model = process.env.PLANNER_MODEL || 'gemma4:12b';
const baseUrl = process.env.PLANNER_URL || 'http://127.0.0.1:11434/v1';
const t0 = Date.now();
const calls = [];

const pointAt = createTool({
  name: 'point_at',
  description: 'Point the ghost cursor at one page element by its id and show a short hint.',
  inputSchema: {
    type: 'object',
    properties: { element_id: { type: 'string' }, hint: { type: 'string' } },
    required: ['element_id', 'hint'],
  },
  execute: async (input) => {
    calls.push({ tool: 'point_at', input });
    return { ok: true };
  },
});
const finish = createTool({
  name: 'finish',
  description: 'End the task with a short message.',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  lifecycle: { completesRun: true },
  execute: async (input) => {
    calls.push({ tool: 'finish', input });
    return { ok: true };
  },
});

const agent = new Agent({
  providerId: 'openai-compatible',
  modelId: model,
  baseUrl,
  apiKey: 'ollama',
  systemPrompt: 'You are a browser guide. Act ONLY by calling tools. Never answer in plain text.',
  tools: [pointAt, finish],
  maxIterations: 4,
});
const events = new Set();
agent.subscribe((e) => events.add(e.type));
const timer = setTimeout(() => agent.abort('spike timeout'), 240_000);
try {
  const result = await agent.run(
    'The page has element e7 = the "Register as new elector" button. Point at it with a short hint, then call finish.',
  );
  console.log(JSON.stringify({ model, status: result.status, ms: Date.now() - t0, calls, events: [...events], error: result.error?.message }));
} catch (error) {
  console.log(JSON.stringify({ model, status: 'threw', ms: Date.now() - t0, calls, events: [...events], error: String(error) }));
} finally {
  clearTimeout(timer);
}
