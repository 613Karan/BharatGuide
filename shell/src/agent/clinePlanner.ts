/**
 * Cline SDK planner (spec D3, 8.1, 8.2). Runs in the Electron main process
 * (Electron 38 = Node 22, satisfies the SDK's engines field).
 *
 * - Only our tools are registered. The SDK `Agent` (AgentRuntime) has no
 *   built-in shell/file/browser/MCP tools; it can only call what we pass.
 * - Every tool's execute() delegates to the guarded executor.
 * - `finish` carries lifecycle.completesRun so the run ends cleanly.
 * - Abort: agent.abort() on Esc-Esc, overlay loss, caps, or a tool `stop`.
 *
 * @cline/sdk is ESM-only. The main bundle is CJS, so it is loaded with a native
 * dynamic import() (Rollup keeps import() for externals in CJS output).
 */
import { MAX_ITERATIONS, SYSTEM_PROMPT, userTurn, type Planner, type PlannerDeps } from './planner';
import { jsonSchemaFor } from './schema';
import { ALL_TOOLS } from './tools';
import type { LoggerPort, TaskContext } from './types';

export type ClineModelConfig = {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
};

type SdkModule = typeof import('@cline/sdk');

let sdkPromise: Promise<SdkModule> | null = null;
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@cline/sdk');
  return sdkPromise;
}

export class ClinePlanner implements Planner {
  readonly name = 'cline-sdk';
  private agent: { abort(reason?: unknown): void } | null = null;
  private cancelled = false;

  constructor(
    private readonly model: ClineModelConfig,
    private readonly deps: PlannerDeps,
    private readonly logger: LoggerPort,
  ) {}

  async run(userMessage: string, ctx: TaskContext): Promise<void> {
    this.cancelled = false;
    const sdk = await loadSdk();
    const tools = ALL_TOOLS.map((tool) =>
      sdk.createTool({
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchemaFor(tool),
        timeoutMs: tool.name === 'wait_for_user' ? 130_000 : 45_000,
        retryable: false,
        lifecycle: tool.name === 'finish' ? { completesRun: true } : undefined,
        execute: async (input: unknown) => {
          const output = await this.deps.exec(tool.name, input);
          if (output.stop) queueMicrotask(() => this.agent?.abort('shell stopped the task'));
          return output;
        },
      }),
    );

    const agent = new sdk.Agent({
      providerId: this.model.providerId,
      modelId: this.model.modelId,
      baseUrl: this.model.baseUrl,
      apiKey: this.model.apiKey,
      systemPrompt: SYSTEM_PROMPT,
      tools,
      maxIterations: MAX_ITERATIONS,
      toolExecution: 'sequential',
    });
    this.agent = agent;

    let freeText = '';
    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case 'assistant-text-delta':
          // Not streamed directly: model text must pass the guard (spec rule 8/9).
          freeText = event.accumulatedText;
          break;
        case 'turn-started':
          freeText = '';
          break;
        case 'tool-started':
          this.logger.info('planner', 'tool-started', { tool: event.toolCall.toolName });
          break;
        case 'run-failed':
          this.logger.warn('planner', 'run-failed', { error: String(event.error?.message ?? event.error) });
          break;
        default:
          break;
      }
    });

    const abortOnSignal = (): void => agent.abort('cancelled');
    ctx.signal.addEventListener('abort', abortOnSignal);
    try {
      if (this.cancelled || ctx.signal.aborted) return;
      const context = await this.deps.buildContext();
      const result = await agent.run(userTurn(userMessage, context));
      this.logger.info('planner', 'run-finished', { status: result.status, iterations: result.iterations });
      if (result.status === 'failed' && !ctx.stopped && !ctx.finished) {
        throw new Error(result.error?.message ?? 'planner run failed');
      }
      const tail = (result.outputText || freeText).trim();
      if (tail && !ctx.stopped && !ctx.finished && result.status === 'completed') await this.deps.onFreeText(tail);
    } finally {
      ctx.signal.removeEventListener('abort', abortOnSignal);
      unsubscribe();
      this.agent = null;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.agent?.abort('cancelled by the user');
  }
}
