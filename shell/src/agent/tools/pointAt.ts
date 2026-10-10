import { z } from 'zod';
import { center, checkUserFacingText, describePage, telegraph } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({
  target_area: z.enum(['page', 'toolbar']).describe('"page" for an element of the web page, "toolbar" for the browser toolbar'),
  target_id: z
    .string()
    .describe('page: element id from <page> like "e12". toolbar: "address_bar", "back", "forward", "reload", "new_tab" or "tab:<tab id>"'),
  hint: z.string().min(1).max(140).describe('One short line shown next to the ghost, e.g. "Click here to register"'),
  kind: z.enum(['ui', 'fact']).default('ui'),
  source_ids: z.array(z.string()).optional(),
});

const SELF_HINT = /yourself|you (need|have) to|please (enter|type|fill|do)/i;

export const pointAt: ToolDef<z.infer<typeof schema>> = {
  name: 'point_at',
  description:
    'Fly the ghost cursor to an element and show a one-line hint. If the element is off screen the page scrolls it into view first. Never clicks. For login/OTP/Aadhaar/EPIC/payment fields, point and tell the user to do it themselves.',
  schema,
  async execute(input, ctx, host) {
    let hint = input.hint.trim();
    const check = checkUserFacingText(hint, input.kind, input.source_ids, ctx.chunks);
    if (!check.ok) return { error: `hint rejected: ${check.reason}` };

    if (input.target_area === 'toolbar') {
      const rect = host.browser.toolbarRect(input.target_id);
      if (!rect) return { error: `unknown toolbar target "${input.target_id}"` };
      await telegraph(host, ctx, center(rect), hint);
      return { ok: true, pointed: input.target_id };
    }

    let info = await host.browser.elementInfo(input.target_id);
    if (!info.found) return { error: `element ${input.target_id} is not on the current page; use an id from the latest <page>` };
    const origin = host.browser.pageOrigin();
    const size = host.browser.pageSize();
    let scrolled: 'up' | 'down' | undefined;
    if (!info.inViewport) {
      // Off screen: telegraph the scroll at the edge, then actually bring the
      // element into view so the ghost can point at it. Scrolling only reveals
      // content; it never clicks or types (spec 6.3).
      const below = info.rect.y > 0;
      scrolled = below ? 'down' : 'up';
      const x = origin.x + Math.min(Math.max(info.rect.x + info.rect.width / 2, 40), size.width - 40);
      const y = origin.y + (below ? size.height - 30 : 30);
      await telegraph(host, ctx, { x, y }, below ? 'Scrolling down' : 'Scrolling up', false);
      host.ghost.ripple(x, y);
      await host.browser.scrollIntoView(input.target_id);
      await host.sleep(700, ctx.signal); // smooth scroll settles
      info = await host.browser.elementInfo(input.target_id);
      if (!info.found) return { error: `element ${input.target_id} disappeared after scrolling; take a fresh look at the page` };
      if (!info.inViewport) {
        await telegraph(host, ctx, { x, y }, below ? 'Scroll down' : 'Scroll up');
        return { ok: true, offscreen: true, note: `could not scroll the element into view; the user was asked to scroll ${scrolled}` };
      }
    }
    if (info.sensitive && !SELF_HINT.test(hint)) hint = `${hint} (please do this yourself)`;
    const c = center(info.rect);
    await telegraph(host, ctx, { x: origin.x + c.x, y: origin.y + c.y }, hint);
    const extra = scrolled ? { scrolled, page: describePage(await host.browser.snapshot()) } : {};
    return info.sensitive
      ? { ok: true, sensitive: true, ...extra, note: 'sensitive field: the user must fill this themselves; never click or type here' }
      : { ok: true, pointed: input.target_id, ...extra };
  },
};
