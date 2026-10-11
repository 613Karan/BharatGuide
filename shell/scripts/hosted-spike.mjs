// Spike: does the Cline SDK drive tool calls on the hosted planner from .env?
// Run from shell/: node scripts/hosted-spike.mjs [modelId] [providerId]
// Reads PLANNER_URL / PLANNER_API_KEY / PLANNER_MODEL from ../.env. Never prints the key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent, createTool } from '@cline/sdk';

const env = {};
for (const raw of readFileSync(resolve(process.cwd(), '..', '.env'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const at = line.indexOf('=');
  env[line.slice(0, at).trim().replace(/^\uFEFF/, '')] = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
}

const model = process.argv[2] || env.PLANNER_MODEL;
const providerId = process.argv[3] || env.PLANNER_PROVIDER_ID || 'openai-compatible';
const baseUrl = env.PLANNER_URL || 'https://api.cline.bot/api/v1';
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
  providerId,
  modelId: model,
  baseUrl,
  apiKey: env.PLANNER_API_KEY,
  systemPrompt: 'You are a browser guide. Act ONLY by calling tools. Never answer in plain text.',
  tools: [pointAt, finish],
  maxIterations: 4,
});
const timer = setTimeout(() => agent.abort('spike timeout'), 60_000);
let out;
try {
  const result = await agent.run(
    'The page has element e7 = the "Register as new elector" button. Point at it with a short hint, then call finish.',
  );
  out = { model, providerId, status: result.status, ms: Date.now() - t0, calls: calls.map((c) => c.tool), error: result.error?.message };
} catch (error) {
  out = { model, providerId, status: 'threw', ms: Date.now() - t0, calls: calls.map((c) => c.tool), error: String(error).slice(0, 300) };
} finally {
  clearTimeout(timer);
}
console.log(JSON.stringify(out));
