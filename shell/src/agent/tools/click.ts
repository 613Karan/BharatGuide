import { z } from 'zod';
import { center, describePage, telegraph } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({
  element_id: z.string().describe('Element id from the latest <page>, e.g. "e12"'),
});

export const click: ToolDef<z.infer<typeof schema>> = {
  name: 'click',
  description:
    'Click one page element (CDP, never the real mouse). ONLY when the user explicitly asked for a click, or during a search command. Refused on login/OTP/payment/Aadhaar/EPIC fields.',
  schema,
  async execute(input, ctx, host) {
    const info = await host.browser.elementInfo(input.element_id);
    if (!info.found) return { error: `element ${input.element_id} is not on the current page` };
    if (info.sensitive) {
      return { error: 'refused: this is a sensitive field (login/OTP/payment/ID). Point at it and ask the user to do it themselves' };
    }
    if (!info.inViewport) return { error: 'the element is off screen; scroll first (only if the user asked) or point toward it' };
    const c = center(info.rect);
    const origin = host.browser.pageOrigin();
    const screen = { x: origin.x + c.x, y: origin.y + c.y };
    await telegraph(host, ctx, screen, 'Clicking here');
    host.ghost.ripple(screen.x, screen.y);
    await host.browser.click(c.x, c.y);
    await host.sleep(700, ctx.signal);
    return { ok: true, clicked: input.element_id, page: describePage(await host.browser.snapshot()) };
  },
};
