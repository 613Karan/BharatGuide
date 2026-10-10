import { z } from 'zod';
import { describePage } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({});

export const pressEnter: ToolDef<z.infer<typeof schema>> = {
  name: 'press_enter',
  description: 'Submit the search. Only immediately after a successful type_in_search.',
  schema,
  async execute(_input, ctx, host) {
    if (ctx.lastSuccessfulTool !== 'type_in_search') {
      return { error: 'press_enter is only allowed right after a granted type_in_search' };
    }
    if (ctx.ghostAt) host.ghost.pulse(ctx.ghostAt.x, ctx.ghostAt.y);
    await host.sleep(400, ctx.signal);
    await host.browser.pressEnter();
    await host.sleep(1500, ctx.signal);
    // Results shown: grant dropped, back to guide mode (spec 8.8).
    ctx.grants.drop();
    ctx.machine.apply('results_shown');
    return { ok: true, page: describePage(await host.browser.snapshot()) };
  },
};
