/**
 * Layer 2: the agent loop + tool plumbing, tested offline and deterministically.
 *
 * A real Agent runs against a stub that speaks the OpenAI-compatible
 * /v1/chat/completions protocol. We control the tool call the "model" emits, so we
 * can assert the SDK correctly:
 *   - sends our tool definitions to the model,
 *   - parses the tool call,
 *   - executes the matching tool,
 *   - feeds the result back and finishes the run.
 *
 * No API key, no network beyond 127.0.0.1, no cost. This layer catches
 * "the model called the tool but the SDK never ran it" style bugs.
 *
 * Run: npm run test:provider   ->  node --test fake-provider.test.ts
 *
 * NOTE: if this fails on the first run, read `requests` in the failure output - the
 * first request body shows the exact wire protocol your SDK version uses. Adjust
 * `respond()` accordingly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Agent } from '@cline/sdk';
import { createGhostTools } from './tools.ts';

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

/** True once the conversation already contains a tool result message. */
function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body['messages'])
    ? (body['messages'] as Record<string, unknown>[])
    : [];
  return messages.some((message) => message['role'] === 'tool');
}

function toolCallChunk(name: string, args: string) {
  return {
    id: 'chatcmpl-tool',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_stub', type: 'function', function: { name, arguments: args } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function textChunk(text: string) {
  return {
    id: 'chatcmpl-text',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'stub-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
}

function finalChunk() {
  return {
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'stub-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
}

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const ARGS = JSON.stringify({ element_id: 'e7', hint: 'Search box' });

/** Canned model behaviour: call point_at first, then say "All done.". */
function respond(res: ServerResponse, body: Record<string, unknown>): void {
  const streaming = body['stream'] === true;
  const done = hasToolResult(body);

  if (streaming) {
    if (done) {
      sse(res, [textChunk('All done.'), finalChunk()]);
    } else {
      sse(res, [toolCallChunk('point_at', ARGS), { ...finalChunk(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
    }
    return;
  }

  const message = done
    ? { role: 'assistant', content: 'All done.' }
    : {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_stub', type: 'function', function: { name: 'point_at', arguments: ARGS } },
        ],
      };

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'stub-model',
      choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

test('Agent advertises tools, executes the tool call, and ends the run (offline)', async (t) => {
  const requests: CapturedRequest[] = [];

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ method: req.method ?? '', url: req.url ?? '', body });

    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
      return;
    }

    respond(res, body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => server.close());

  const { tools, calls } = createGhostTools();
  const agent = new Agent({
    providerId: 'openai-compatible',
    modelId: 'stub-model',
    apiKey: 'stub-key',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    systemPrompt: 'You are a browsing guide. Use point_at to show the user where something is.',
    tools,
    maxIterations: 3,
  });

  const eventTypes: string[] = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const result = await agent.run('Show me where the search box is, then finish.');

  const diagnostics = (): string =>
    [
      `status=${result.status}`,
      `events=${eventTypes.join(', ')}`,
      `calls=${JSON.stringify(calls)}`,
      `urls=${JSON.stringify(requests.map((r) => r.url))}`,
    ].join('\n');

  // 1. The SDK must have offered our tools to the model.
  const chat = requests.find((r) => r.url.includes('chat/completions'));
  assert.ok(chat, `no chat completion request seen.\n${diagnostics()}`);
  const sentTools = (chat!.body['tools'] ?? []) as { function?: { name?: string } }[];
  const sentNames = sentTools.map((entry) => entry.function?.name);
  assert.ok(
    sentNames.includes('point_at'),
    `point_at was not advertised to the model; sent=${JSON.stringify(sentNames)}\n${diagnostics()}`,
  );

  // 2. The tool call the "model" emitted must have been executed.
  assert.ok(
    calls.some((call) => call.tool === 'point_at'),
    `tool call was parsed but never executed.\n${diagnostics()}`,
  );
  assert.deepEqual(
    calls.find((call) => call.tool === 'point_at')?.input,
    { element_id: 'e7', hint: 'Search box' },
    `arguments were not passed through intact.\n${diagnostics()}`,
  );

  // 3. The run must terminate cleanly rather than hitting maxIterations.
  assert.equal(result.status, 'completed', `run did not complete.\n${diagnostics()}`);
});
