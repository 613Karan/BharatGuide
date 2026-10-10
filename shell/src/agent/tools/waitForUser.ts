import { z } from 'zod';
import { describePage } from '../guardrails';
import type { ToolDef } from '../types';

export const DEFAULT_WAIT_MS = 60_000;

const schema = z.object({
  event: z.enum(['focus', 'click', 'input', 'navigation', 'any']).describe('What the user should do on the page'),
  hint: z.string().min(1).max(100).describe('Short phrase completing "Waiting for you to …", e.g. "click \'Register\'"'),
  timeout_s: z.number().int().min(5).max(120).optional(),
});

export const waitForUser: ToolDef<z.infer<typeof schema>> = {
  name: 'wait_for_user',
  description: 'Pause until the user does something on the page (they use their own mouse/keyboard). Returns a fresh <page>.',
  schema,
  async execute(input, ctx, host) {
    ctx.machine.apply('wait_entered');
    const timeoutMs = (input.timeout_s ?? DEFAULT_WAIT_MS / 1000) * 1000;
    const event = await host.browser.waitForEvent(input.event, timeoutMs, ctx.signal);
    if (ctx.signal.aborted) return { stop: true, error: 'stopped' };
    ctx.machine.apply('user_acted');
    await host.sleep(400, ctx.signal);
    const page = describePage(await host.browser.snapshot());
    if (!event) {
      return { ok: false, timed_out: true, note: 'the user did not act in time; ask whether they need help', page };
    }
    return {
      ok: true,
      user_did: event.type,
      element: event.elementId ?? null,
      element_name: event.name ?? null,
      search_value: event.isSearch ? event.value ?? '' : undefined,
      page,
    };
  },
};
