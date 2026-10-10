/**
 * Fast local model for the Cline SDK planner.
 *
 * Measured on this machine (gemma4:12b via Ollama):
 *   - /v1/chat/completions with reasoning_effort:"none"  ->  ~0.8 s for a short reply
 *   - default (thinking on)                              -> ~17-23 s per step
 * The SDK's openai-compatible provider does not forward reasoning_effort to
 * Ollama, so we hand the SDK a pre-built AgentModel (AgentRuntime's documented
 * advanced form) that streams from Ollama with thinking disabled.
 * The SDK still owns the loop, tool execution, events and abort.
 */
import type { AgentModel, AgentModelEvent, AgentModelRequest } from '@cline/shared';
import type { LoggerPort } from './types';

type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown };
type Msg = { role: string; content: readonly Part[] };

export type FastModelConfig = { baseUrl: string; modelId: string; apiKey: string; reasoningEffort: string };

/** Convert SDK messages to OpenAI chat messages. */
export function toOpenAiMessages(systemPrompt: string | undefined, messages: readonly Msg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
    if (m.role === 'user') {
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const calls = m.content
        .filter((p) => p.type === 'tool-call')
        .map((p) => ({ id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
    // Tool results can live on 'tool' or 'user' messages depending on the SDK path.
    for (const p of m.content) {
      if (p.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) });
      }
    }
  }
  return out;
}

export function createFastModel(config: FastModelConfig, logger: LoggerPort): AgentModel {
  return {
    async *stream(request: AgentModelRequest): AsyncGenerator<AgentModelEvent> {
      const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const body = {
        model: config.modelId,
        messages: toOpenAiMessages(request.systemPrompt, request.messages),
        tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        tool_choice: 'auto',
        temperature: 0.2,
        reasoning_effort: config.reasoningEffort,
        stream: false,
      };
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey || 'none'}` },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        yield { type: 'finish', reason: request.signal?.aborted ? 'aborted' : 'error', error: String(error) };
        return;
      }
      if (!response.ok) {
        yield { type: 'finish', reason: 'error', error: `model HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
        return;
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      logger.info('planner', 'model step', { ms: Date.now() - started, reasoning: config.reasoningEffort });
      const message = data.choices?.[0]?.message ?? {};
      if (message.content) yield { type: 'text-delta', text: message.content };
      const calls = message.tool_calls ?? [];
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        yield { type: 'tool-call-delta', index, toolCallId: call.id || `call_${index}`, toolName: call.function.name, inputText: call.function.arguments || '{}' };
      }
      if (data.usage) yield { type: 'usage', usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } };
      yield { type: 'finish', reason: calls.length ? 'tool-calls' : 'stop' };
    },
  };
}
