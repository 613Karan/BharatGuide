import { z } from 'zod';
import { checkUrl } from '../allowlist';
import type { ToolDef } from '../types';
import { pageAfterLoad, telegraphAddressBar } from './navigation';

const schema = z.object({ url: z.string().describe('Full https URL. Must be allowlisted or a source_url from search_docs in this task') });

export const navigate: ToolDef<z.infer<typeof schema>> = {
  name: 'navigate',
  description: 'Load an allowlisted https URL in the ACTIVE tab. The ghost flies to the address bar first.',
  schema,
  async execute(input, ctx, host) {
    const check = checkUrl(input.url, host.config.allowedHosts, ctx.sourceHosts);
    if (!check.ok) return { error: check.reason };
    if (!host.browser.activeTabId()) {
      await telegraphAddressBar(host, ctx, check.url);
      await host.browser.openTab(check.url);
    } else {
      await telegraphAddressBar(host, ctx, check.url);
      await host.browser.navigate(check.url);
    }
    return { ok: true, page: await pageAfterLoad(host, ctx.signal) };
  },
};
