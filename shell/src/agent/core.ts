/**
 * Agent core (spec 5, 8). Data flow:
 *   chat message -> redact -> intent check (code) -> Planner -> tool call ->
 *   guardrails -> (RAG | ghost telegraph -> action) -> result -> ... -> finish
 *
 * Owns the state machine, the TypingGrant (created ONLY here, from the user's
 * own message), the kill switch, the run caps and the halted card.
 */
import { randomUUID } from 'node:crypto';
import { redact } from '../rag/redact';
import type { AgentState } from '../shared/ipc';
import { HALT_TEXT, buildRunContext, type HaltReason } from './context';
import { runTool, type HaltFn } from './executor';
import type { Chunk } from './grounding';
import { checkUserFacingText } from './guardrails';
import { classifyIntent } from './intent';
import { RUN_TIME_CAP_MS, type Planner, type PlannerDeps } from './planner';
import { streamAssistant } from './speak';
import { StateMachine } from './stateMachine';
import { STATUS_THINKING } from './status';
import { GrantStore } from './typingGrant';
import type { Host, TaskContext } from './types';

/** Page labels shown in chat/hints: one line, short, no quote marks (keeps the fact guard out of UI text). */
function clip(label: string): string {
  return label.replace(/\s+/g, ' ').replace(/["“”'‘’]/g, '').trim().slice(0, 60);
}

export const DOUBLE_ESC_MS = 800;
export type PlannerFactory = (deps: PlannerDeps) => Planner;

export class AgentCore {
  readonly machine: StateMachine;
  readonly grants = new GrantStore();
  private planner: Planner | null = null;
  private task: TaskContext | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private lastEscAt = 0;
  /** Session memory so follow-ups ("next step") keep their sources (S1, S2, ...). */
  private readonly sessionChunks = new Map<string, Chunk>();
  private readonly sessionSourceHosts = new Set<string>();
  private readonly history: string[] = [];

  constructor(
    private readonly host: Host,
    private readonly makePlanner: PlannerFactory,
    private readonly searchPhrases: string[] = ['search for', 'find'],
  ) {
    this.machine = new StateMachine((state) => {
      this.host.chat.emit({ t: 'state', state });
      this.host.logger.info('state', state, { taskId: this.task?.taskId });
    });
  }

  get state(): AgentState {
    return this.machine.state;
  }

  get currentTask(): TaskContext | null {
    return this.task;
  }

  /** Entry point for every chat message (ChatCommand 'send'). */
  async handleUserMessage(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    // Rule 13: redact before display history, logs, planner and RAG.
    const { text: clean, redacted } = redact(text);
    this.host.chat.emit({ t: 'user_msg', id: randomUUID(), text: clean, redacted });
    if (redacted) {
      this.host.chat.emit({ t: 'card', kind: 'redaction', body: "I removed a number that looked like a personal ID. Please don't share these." });
    }

    if (this.running) {
      this.cancelCurrent();
      await this.running.catch(() => undefined);
    }
    if (this.machine.state !== 'Idle') this.machine.reset();

    const intent = classifyIntent(clean, this.searchPhrases);
    const abort = new AbortController();
    this.abort = abort;
    this.grants.drop();
    const ctx: TaskContext = {
      taskId: randomUUID(),
      userMessage: clean,
      userAskedClick: intent.kind === 'guidance' ? intent.userAskedClick : true,
      userAskedScroll: intent.kind === 'guidance' ? intent.userAskedScroll : true,
      chunks: this.sessionChunks,
      sourceHosts: this.sessionSourceHosts,
      corpusLastUpdated: null,
      searchCalls: 0,
      toolCalls: 0,
      consecutiveRejections: 0,
      lastSuccessfulTool: null,
      stopped: false,
      finished: false,
      signal: abort.signal,
      machine: this.machine,
      grants: this.grants,
      ghostAt: null,
    };
    this.task = ctx;

    let grantedTitle: string | null = null;
    if (intent.kind === 'search_command') {
      // The ONLY place a TypingGrant is created: the user's explicit command (rule 4).
      grantedTitle = intent.title;
      this.grants.create(ctx.taskId, intent.title, this.host.now());
      this.host.logger.info('grant', 'created', { taskId: ctx.taskId });
      await streamAssistant(this.host, `Searching for: **${intent.title}**`);
      this.machine.apply('search_command');
    } else {
      this.machine.apply('user_message');
    }

    this.host.chat.emit({ t: 'status', text: STATUS_THINKING });
    this.showGhostAtRest(ctx);
    // "Guide me to X": find X on the page and point, in code. Only if it is not
    // on the page does the planner (model) take over.
    if (intent.kind === 'guidance' && intent.locate && (await this.locateOnPage(intent.locate, ctx))) {
      this.history.push(`user asked: ${clean.slice(0, 160)} (pointed at it)`);
      this.host.chat.emit({ t: 'status', text: null });
      if (this.machine.state !== 'Halted') this.machine.apply('finish');
      if (this.task === ctx) this.task = null;
      return;
    }
    const run = this.runPlanner(clean, ctx, grantedTitle);
    this.running = run;
    await run;
    if (this.running === run) this.running = null;
  }
  private async runPlanner(message: string, ctx: TaskContext, grantedTitle: string | null): Promise<void> {
    const halt: HaltFn = (reason, detail) => this.halt(reason, detail);
    const deps: PlannerDeps = {
      exec: (name, input) => runTool(name, input, ctx, this.host, halt),
      onFreeText: async (text) => {
        // Free model text appears only if it passes the same guard as a ui reply.
        if (ctx.stopped || ctx.finished) return;
        const check = checkUserFacingText(text, 'ui', [], ctx.chunks);
        if (check.ok) await streamAssistant(this.host, text, undefined, ctx.signal);
        else this.host.logger.warn('planner', 'free text suppressed', { reason: check.reason });
      },
      buildContext: () => buildRunContext(this.host, ctx, grantedTitle, this.history),
    };
    const planner = this.makePlanner(deps);
    this.planner = planner;
    const timer = setTimeout(() => this.halt('time_cap'), RUN_TIME_CAP_MS);
    try {
      await planner.run(message, ctx);
      this.history.push(`user asked: ${message.slice(0, 160)}`);
    } catch (error) {
      if (!ctx.signal.aborted && !ctx.stopped) {
        this.host.logger.error('planner', 'run failed', { error: String(error) });
        this.host.chat.emit({
          t: 'card',
          kind: 'service_down',
          body: 'The assistant could not reach its language model, so no answer was given.',
          helpline: this.host.config.helplineFallback,
        });
      }
    } finally {
      clearTimeout(timer);
      if (this.planner === planner) this.planner = null;
      this.host.chat.emit({ t: 'status', text: null });
      if (this.machine.state !== 'Halted') {
        this.grants.drop();
        this.machine.apply('finish');
        if (this.machine.state !== 'Idle') this.machine.reset();
      }
      if (this.task === ctx) this.task = null;
    }
  }

  /** Point at a visible label through the guarded executor. true = handled. */
  private async locateOnPage(target: string, ctx: TaskContext): Promise<boolean> {
    const halt: HaltFn = (reason, detail) => this.halt(reason, detail);
    const hit = await this.host.browser.findByText(target).catch(() => null);
    const similar = hit ? [] : await this.host.browser.similarLabels(target).catch(() => [] as string[]);
    this.host.logger.info('agent', 'locate', { target, found: Boolean(hit), name: hit?.name, score: hit?.score, similar });

    if (!hit) {
      if (!similar.length) return false; // nothing related here: let the planner help
      // No exact match, but related options exist (e.g. "Track Appeal" for
      // "submit appeal"). Say so honestly, point at the closest one, list the rest.
      const closest = await this.host.browser.findByText(similar[0]).catch(() => null);
      if (closest) {
        const out = await runTool('point_at', { target_area: 'page', target_id: closest.id, hint: `Closest match: ${clip(similar[0])}` }, ctx, this.host, halt);
        if (out.stop) return true;
      }
      const list = similar.map((s) => `- ${clip(s)}`).join('\n');
      await runTool(
        'finish',
        { message: `I couldn't find an option called **${clip(target)}** on this page. The closest options here are:\n${list}\nThe ghost is pointing at the first one. Ask me about any of them.` },
        ctx,
        this.host,
        halt,
      );
      return true;
    }

    const label = clip(hit.name);
    const out = await runTool('point_at', { target_area: 'page', target_id: hit.id, hint: `Here: ${label}` }, ctx, this.host, halt);
    if (out.error || out.stop) return Boolean(out.stop);
    const sensitive = Boolean(out.sensitive);
    await runTool(
      'finish',
      { message: sensitive ? `That's **${label}**. Please fill it in yourself.` : `That's **${label}**, where the ghost is pointing. Click it when you're ready.` },
      ctx,
      this.host,
      halt,
    );
    return true;
  }

  /**
   * Rule 2: the ghost is visible the whole time a task runs, not only when a
   * tool moves it. It appears (pulse, no flight) at a resting spot near the top
   * of the page and every later flight starts from there.
   */
  private showGhostAtRest(ctx: TaskContext): void {
    const origin = this.host.browser.pageOrigin();
    const size = this.host.browser.pageSize();
    const rest = { x: origin.x + Math.round(size.width * 0.42), y: origin.y + 70 };
    ctx.ghostAt = rest;
    this.host.ghost.pulse(rest.x, rest.y);
  }

  /** Esc pressed anywhere we can observe it. Twice within 800 ms = kill. */
  handleEsc(): void {
    const now = this.host.now();
    if (this.lastEscAt && now - this.lastEscAt <= DOUBLE_ESC_MS) {
      this.lastEscAt = 0;
      this.kill();
    } else {
      this.lastEscAt = now;
    }
  }

  /** Kill switch (rule 6): abort the run, drop the grant, Halted, card. */
  kill(): void {
    if (this.task) this.halt('user');
  }

  handleOverlayLost(): void {
    if (this.task) this.halt('overlay');
  }

  private halt(reason: HaltReason, detail?: string): void {
    const task = this.task;
    if (!task || this.machine.state === 'Halted') return;
    this.host.logger.warn('halt', reason, { detail, taskId: task.taskId });
    task.stopped = true;
    this.cancelCurrent();
    this.grants.drop();
    this.machine.apply('halt');
    this.host.ghost.hide();
    this.host.chat.emit({ t: 'status', text: null });
    this.host.chat.emit({ t: 'card', kind: 'halted', body: HALT_TEXT[reason] });
  }

  private cancelCurrent(): void {
    this.abort?.abort();
    this.planner?.cancel();
  }

  async shutdown(): Promise<void> {
    this.cancelCurrent();
    this.grants.drop();
    await this.running?.catch(() => undefined);
  }
}
