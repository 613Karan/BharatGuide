/**
 * Real-task demo: "I just turned 18 - help me register as a new voter."
 *
 * Scripted (no LLM) so it is reliable on stage, but every step goes through the
 * SAME guarded executor the model uses: answers come from search_docs and are
 * fact-checked against the retrieved chunks, the ghost telegraphs before
 * acting, the user does the clicks, and personal fields are left to the user.
 * Triggered by "/demo-register" in chat or `electron . --demo=register`.
 */
import type { SnapElement } from '../shared/page';
import type { Planner, PlannerDeps } from './planner';
import type { BrowserPort, LoggerPort, TaskContext } from './types';

const PAUSE_MS = 1500;
const PORTAL = 'https://voters.eci.gov.in/';
const SENSITIVE_NAME = /mobile|phone|otp|password|captcha|aadhaa?r|epic/i;

export const REGISTER_DEMO_MESSAGE = 'I just turned 18. Help me register as a new voter.';

export const REGISTER_ANSWER = [
  'New voters apply with **Form 6** (Application Form for New Voters).',
  'Keep these ready before you start:',
  '- **Age proof**, for example a birth certificate or Aadhaar Card',
  '- **Address proof**, for example a water/electricity/gas bill, Aadhaar Card, bank or post office passbook, or Indian Passport',
  'You can apply online on the ECI voters portal. I will show you where to click; you do the clicking and typing.',
].join('\n');

export class RegisterDemoPlanner implements Planner {
  readonly name = 'demo-register';
  private cancelled = false;

  constructor(
    private readonly deps: PlannerDeps,
    private readonly browser: BrowserPort,
    private readonly logger: LoggerPort,
  ) {}

  private async elements(): Promise<SnapElement[]> {
    return (await this.browser.snapshot())?.elements ?? [];
  }

  private async findLink(pattern: RegExp): Promise<SnapElement | null> {
    const els = await this.elements();
    return (
      els.find((e) => e.inViewport && !e.sensitive && ['link', 'button'].includes(e.role) && pattern.test(e.name)) ??
      els.find((e) => !e.sensitive && pattern.test(e.name)) ??
      null
    );
  }

  /** Poll until the page has rendered a matching link (slow government portals). */
  private async waitForLink(pattern: RegExp, timeoutMs = 12_000): Promise<SnapElement | null> {
    const until = Date.now() + timeoutMs;
    while (!this.cancelled && Date.now() < until) {
      const found = await this.findLink(pattern);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** A field the user must fill in themselves (login: mobile / OTP / captcha). */
  private async findPersonalField(): Promise<SnapElement | null> {
    const els = await this.elements();
    return (
      els.find((e) => e.inViewport && (e.sensitive || (['textbox', 'searchbox'].includes(e.role) && SENSITIVE_NAME.test(e.name)))) ?? null
    );
  }

  /** Runs one tool; go=false means stop the demo (halt, Esc, or a stopping error). */
  private async step(name: string, input: unknown, pause = PAUSE_MS): Promise<{ go: boolean; out: Record<string, unknown> }> {
    if (this.cancelled) return { go: false, out: {} };
    const out = (await this.deps.exec(name, input)) as Record<string, unknown>;
    this.logger.info('demo', name, { ok: !out.error, error: out.error });
    if (out.stop) return { go: false, out };
    if (pause) await new Promise((r) => setTimeout(r, pause));
    return { go: !this.cancelled, out };
  }

  cancel(): void {
    this.cancelled = true;
  }

  // run() is defined below.
  async run(message: string, ctx: TaskContext): Promise<void> {
    await this.script(message, ctx);
  }

  private async script(_message: string, ctx: TaskContext): Promise<void> {
    this.cancelled = false;
    const go = async (name: string, input: unknown, pause?: number) => (await this.step(name, input, pause)).go;
    const sources = () => [...ctx.chunks.keys()];

    // 1. Look it up in the official documents first (facts only from sources).
    if (!(await go('reply', { kind: 'ui', text: "Congratulations! Let's get you on the voter list. First I'll check the official ECI documents." }))) return;
    if (!(await go('search_docs', { query: 'how to register as a new voter Form 6', org: 'ECI' }, 300))) return;
    if (!(await go('search_docs', { query: 'documents for proof of age and proof of residence Form 6', org: 'ECI' }, 300))) return;

    // 2. Grounded, cited answer: which form, what to keep ready.
    const facts = await this.step('reply', { kind: 'fact', text: REGISTER_ANSWER, source_ids: sources() });
    if (!facts.go) return;
    if (facts.out.error) {
      // Grounding rejected something: fall back to a minimal, cited line.
      const short = 'New voters apply with **Form 6**, with one age proof and one address proof.';
      if (!(await go('reply', { kind: 'fact', text: short, source_ids: sources() }))) return;
    }

    // 3. Open the official portal and show the right entry point.
    if (!(await go('navigate', { url: PORTAL }, 2500))) return;
    const form6 = await this.waitForLink(/fill form 6\b|new voter registration|form 6\b/i);
    if (!form6) {
      await go('finish', { message: 'The portal is open. Look for the Form 6 (new voter registration) option on the home page.', source_ids: sources() }, 0);
      return;
    }
    // Show where to track the application later. It sits lower on the page, so
    // point_at scrolls it into view first, then scrolls back up to Form 6.
    const track = await this.findLink(/track application status|track application|application status/i);
    if (track && !(await go('point_at', { target_area: 'page', target_id: track.id, hint: 'After you apply, track your application here' }))) return;

    const hint = 'Click here to start Form 6';
    if (!(await go('point_at', { target_area: 'page', target_id: form6.id, hint, kind: 'fact', source_ids: sources() }))) return;

    // 4. The user clicks with their own mouse; the assistant waits and never clicks for them.
    const waited = await this.step('wait_for_user', { event: 'any', hint: 'click Fill Form 6', timeout_s: 60 }, 1200);
    if (!waited.go) return;
    if (waited.out.timed_out) {
      await go('finish', { message: 'No rush. When you are ready, click the highlighted Form 6 link and ask me for the next step.', source_ids: sources() }, 0);
      return;
    }

    // 5. Sign-in needs personal details: point at the field, the user types it.
    const field = await this.findPersonalField();
    const selfHint = 'Enter this yourself. I never type mobile numbers, OTPs or passwords';
    if (field) {
      if (!(await go('point_at', { target_area: 'page', target_id: field.id, hint: selfHint }))) return;
    } else {
      const text = 'The portal will ask you to sign in or sign up with your mobile number and an OTP. Please type those yourself; I never handle them.';
      if (!(await go('reply', { kind: 'ui', text }))) return;
    }

    if (ctx.signal.aborted) return;
    const closing =
      'Next: sign in, open **Form 6**, fill in your details and upload your age and address proof. After you submit, note the reference number so you can track your application.';
    await go('finish', { message: closing, source_ids: sources() }, 0);
  }
}

