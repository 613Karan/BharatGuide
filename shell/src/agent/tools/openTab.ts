import { z } from 'zod';
import { checkUrl } from '../allowlist';
import type { ToolDef } from '../types';
import { pageAfterLoad, telegraphAddressBar } from './navigation';

const schema = z.object({ url: z.string().describe('Full https URL. Must be allowlisted or a source_url from search_docs in this task') });

export const openTab: ToolDef<z.infer<typeof schema>> = {
  name: 'open_tab',
  description: 'Open an allowlisted https URL in a NEW tab (max 6 tabs). The ghost flies to the address bar first.',
  schema,
  async execute(input, ctx, host) {
    const check = checkUrl(input.url, host.config.allowedHosts, ctx.sourceHosts);
    if (!check.ok) return { error: check.reason };
    if (host.browser.listTabs().length >= host.browser.maxTabs()) {
      return { error: `at most ${host.browser.maxTabs()} tabs; use navigate or switch_tab instead` };
    }
    await telegraphAddressBar(host, ctx, check.url);
    const id = await host.browser.openTab(check.url);
    return { ok: true, tab_id: id, page: await pageAfterLoad(host) };
  },
};
