import { z } from 'zod';
import { describePage, telegraph } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({
  direction: z.enum(['up', 'down']),
  amount: z.number().int().min(50).max(4000).optional().describe('Pixels; capped at one screen height'),
});

export const scroll: ToolDef<z.infer<typeof schema>> = {
  name: 'scroll',
  description: 'Scroll the active page by at most one screen. ONLY when the user asked to scroll, or during a search command.',
  schema,
  async execute(input, ctx, host) {
    const size = host.browser.pageSize();
    const amount = Math.min(input.amount ?? Math.round(size.height * 0.85), size.height);
    const origin = host.browser.pageOrigin();
    const px = { x: size.width / 2, y: size.height / 2 };
    const screen = { x: origin.x + px.x, y: origin.y + px.y };
    await telegraph(host, ctx, screen, input.direction === 'down' ? 'Scrolling down' : 'Scrolling up');
    host.ghost.ripple(screen.x, screen.y);
    await host.browser.wheel(px.x, px.y, input.direction === 'down' ? amount : -amount);
    await host.sleep(450, ctx.signal);
    return { ok: true, scrolled: input.direction, amount, page: describePage(await host.browser.snapshot()) };
  },
};
