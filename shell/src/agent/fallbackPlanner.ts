/**
 * Fallback planner (spec 8.6): a plain OpenAI-compatible tool-calling loop
 * behind the same Planner interface. Same tool schemas, same guarded execute.
 * Works with Ollama (/v1) or any hosted OpenAI-compatible endpoint.
 */
import { MAX_ITERATIONS, SYSTEM_PROMPT, userTurn, type Planner, type PlannerDeps } from './planner';
import { jsonSchemaFor } from './schema';
import { ALL_TOOLS } from './tools';
import type { LoggerPort, TaskContext } from './types';

type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type FallbackModelConfig = { baseUrl: string; modelId: string; apiKey: string; reasoningEffort?: string };

export class FallbackPlanner implements Planner {
  readonly name = 'fallback-loop';
  private controller: AbortController | null = null;

  constructor(
    private readonly model: FallbackModelConfig,
    private readonly deps: PlannerDeps,
    private readonly logger: LoggerPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(userMessage: string, ctx: TaskContext): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener('abort', onAbort);
    const tools = ALL_TOOLS.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: jsonSchemaFor(t) },
    }));
    const messages: Msg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userTurn(userMessage, await this.deps.buildContext()) },
    ];
    try {
      for (let i = 0; i < MAX_ITERATIONS; i += 1) {
        if (controller.signal.aborted || ctx.stopped || ctx.finished) return;
        const response = await this.fetchImpl(`${this.model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.model.apiKey || 'none'}` },
          body: JSON.stringify({
            model: this.model.modelId,
            messages,
            tools,
            tool_choice: 'auto',
            temperature: 0.2,
            ...(this.model.reasoningEffort ? { reasoning_effort: this.model.reasoningEffort } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`planner HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        const data = (await response.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
        const message = data.choices?.[0]?.message ?? {};
        const calls = message.tool_calls ?? [];
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls.length ? calls : undefined });
        if (calls.length === 0) {
          if (message.content?.trim()) await this.deps.onFreeText(message.content.trim());
          return;
        }
        for (const call of calls) {
          let args: unknown = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            args = { __invalid_json: call.function.arguments };
          }
          const output = await this.deps.exec(call.function.name, args);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
          if (output.stop || ctx.finished) return;
        }
      }
      this.logger.warn('planner', 'fallback loop hit max iterations');
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
  }
}
