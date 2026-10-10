import { z } from 'zod';
import { center, checkUserFacingText, telegraph } from '../guardrails';
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
    'Fly the ghost cursor to an element and show a one-line hint. Read-only: never clicks. For login/OTP/Aadhaar/EPIC/payment fields, point and tell the user to do it themselves.',
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

    const info = await host.browser.elementInfo(input.target_id);
    if (!info.found) return { error: `element ${input.target_id} is not on the current page; use an id from the latest <page>` };
    const origin = host.browser.pageOrigin();
    const size = host.browser.pageSize();
    if (!info.inViewport) {
      // Off screen: point toward the edge with a scroll hint, never click (spec 6.3).
      const below = info.rect.y > 0;
      const x = origin.x + Math.min(Math.max(info.rect.x + info.rect.width / 2, 40), size.width - 40);
      const y = origin.y + (below ? size.height - 30 : 30);
      await telegraph(host, ctx, { x, y }, below ? 'Scroll down' : 'Scroll up');
      return { ok: true, offscreen: true, note: `the element is ${below ? 'below' : 'above'} the visible area; the user was asked to scroll ${below ? 'down' : 'up'}` };
    }
    if (info.sensitive && !SELF_HINT.test(hint)) hint = `${hint} (please do this yourself)`;
    const c = center(info.rect);
    await telegraph(host, ctx, { x: origin.x + c.x, y: origin.y + c.y }, hint);
    return info.sensitive
      ? { ok: true, sensitive: true, note: 'sensitive field: the user must fill this themselves; never click or type here' }
      : { ok: true, pointed: input.target_id };
  },
};
