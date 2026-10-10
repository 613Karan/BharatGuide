/**
 * Offline verification of the exact Cline wiring - no API key, no credits.
 *
 * The Cline API is OpenAI-compatible at https://api.cline.bot/api/v1. This test points
 * the plain openai-compatible provider at a local stub mounted at /api/v1 and asserts
 * the SDK produces the documented endpoint, auth header and model id. If the wiring
 * here is right, the only thing left for Layer 3 is whether the model picks the tool.
 *
 * Run: npm run test:cline-config   ->  node --test cline-config.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Agent } from '@cline/sdk';
import { createGhostTools } from './tools.ts';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

/** Minimal SSE reply so the run terminates without needing a tool call. */
function finishImmediately(res: import('node:http').ServerResponse): void {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'stub',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(chunk({ role: 'assistant', content: 'ok' }, null));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

test('Cline provider wiring produces the documented endpoint and auth header', async (t) => {
  const seen: { url: string; authorization: string; model: string; tools: string[] }[] = [];

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const tools = Array.isArray(body['tools']) ? (body['tools'] as { function?: { name?: string } }[]) : [];

    seen.push({
      url: req.url ?? '',
      authorization: String(req.headers['authorization'] ?? ''),
      model: String(body['model'] ?? ''),
      tools: tools.map((entry) => entry.function?.name ?? ''),
    });

    finishImmediately(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => server.close());

  const { tools } = createGhostTools();
  const agent = new Agent({
    providerId: 'openai-compatible',
    // Must mirror the real Cline base URL exactly, with a local host substituted.
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    apiKey: 'CLINE_TEST_KEY',
    modelId: 'anthropic/claude-sonnet-4-6',
    systemPrompt: 'You are a browsing guide.',
    tools,
    maxIterations: 2,
  });

  try {
    await agent.run('hello');
  } catch {
    // The run outcome is irrelevant here; we are asserting the outbound request.
  }

  assert.ok(seen.length > 0, 'the SDK sent no request at all');
  const first = seen[0]!;

  assert.equal(
    first.url,
    '/api/v1/chat/completions',
    `baseUrl https://api.cline.bot/api/v1 must resolve to /api/v1/chat/completions, got ${first.url}`,
  );
  assert.equal(first.authorization, 'Bearer CLINE_TEST_KEY', 'auth must be a Bearer token');
  assert.equal(first.model, 'anthropic/claude-sonnet-4-6', 'the Cline provider/model id must pass through');
  assert.ok(
    first.tools.includes('point_at'),
    `our tools must be advertised; sent=${JSON.stringify(first.tools)}`,
  );
});
