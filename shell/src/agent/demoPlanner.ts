/**
 * Ghost-cursor showcase. A scripted Planner (no LLM) that drives every ghost
 * capability through the SAME guarded executor the model uses, so telegraph,
 * guardrails, status subtitles and caps all apply. Triggered by "/demo" in chat
 * or `electron . --demo`.
 */
import type { SnapElement } from '../shared/page';
import type { Planner, PlannerDeps } from './planner';
import type { BrowserPort, LoggerPort, TaskContext } from './types';

const PAUSE_MS = 1300;

export class DemoPlanner implements Planner {
  readonly name = 'demo';
  private cancelled = false;

  constructor(
    private readonly deps: PlannerDeps,
    private readonly browser: BrowserPort,
    private readonly logger: LoggerPort,
  ) {}

  private async find(pattern: RegExp, roles = ['link', 'button']): Promise<SnapElement | null> {
    const snap = await this.browser.snapshot();
    const els = snap?.elements ?? [];
    return (
      els.find((e) => e.inViewport && !e.sensitive && roles.includes(e.role) && pattern.test(e.name)) ??
      els.find((e) => e.inViewport && !e.sensitive && pattern.test(e.name)) ??
      null
    );
  }

  private async step(name: string, input: unknown): Promise<boolean> {
    if (this.cancelled) return false;
    const out = await this.deps.exec(name, input);
    this.logger.info('demo', name, { ok: !out.error, error: out.error });
    if (out.stop) return false;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    return !this.cancelled;
  }

  async run(_message: string, ctx: TaskContext): Promise<void> {
    this.cancelled = false;
    const go = (name: string, input: unknown) => this.step(name, input);

    if (!(await go('reply', { kind: 'ui', text: '**Ghost cursor demo.** Watch the violet arrow: it only *shows* and *telegraphs*. Your real mouse is never moved.' }))) return;
    if (!(await go('point_at', { target_area: 'toolbar', target_id: 'address_bar', hint: 'This is the address bar' }))) return;
    if (!(await go('navigate', { url: 'https://voters.eci.gov.in/' }))) return;

    const register = await this.find(/fill form 6\b|new voter registration/i);
    if (register && !(await go('point_at', { target_area: 'page', target_id: register.id, hint: 'This starts a new voter registration' }))) return;

    const tabId = this.browser.activeTabId();
    if (tabId && !(await go('point_at', { target_area: 'toolbar', target_id: `tab:${tabId}`, hint: 'Your current tab' }))) return;

    if (!(await go('scroll', { direction: 'down' }))) return;
    if (!(await go('scroll', { direction: 'up' }))) return;

    if (!(await go('open_tab', { url: 'https://www.google.com/' }))) return;
    const box = await this.find(/search/i, ['combobox', 'searchbox', 'textbox']);
    if (box && !(await go('click', { element_id: box.id }))) return;

    if (tabId && !(await go('switch_tab', { tab_id: tabId }))) return;
    if (ctx.signal.aborted) return;
    await go('finish', { message: 'Demo done: pointed at the toolbar and page, navigated, scrolled, opened a tab, clicked, and switched tabs. Every action was telegraphed first.' });
  }

  cancel(): void {
    this.cancelled = true;
  }
}
