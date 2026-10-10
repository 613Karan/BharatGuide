import { z } from 'zod';
import { center, describePage, telegraph } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({ tab_id: z.string().describe('Tab id from <tabs>') });

export const switchTab: ToolDef<z.infer<typeof schema>> = {
  name: 'switch_tab',
  description: 'Activate an existing tab. The ghost flies to the tab in the tab strip first.',
  schema,
  async execute(input, ctx, host) {
    const tab = host.browser.listTabs().find((t) => t.id === input.tab_id);
    if (!tab) return { error: `no tab with id "${input.tab_id}"` };
    const rect = host.browser.toolbarRect(`tab:${tab.id}`);
    if (rect) await telegraph(host, ctx, center(rect), `Switching to ${tab.title.slice(0, 40) || 'this tab'}`);
    host.browser.switchTab(tab.id);
    await host.sleep(250, ctx.signal);
    return { ok: true, active: tab.id, page: describePage(await host.browser.snapshot()) };
  },
};
