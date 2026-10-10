/** Shared telegraph for open_tab / navigate: fly to the address bar first (spec 6.4). */
import { center, describePage, telegraph } from '../guardrails';
import type { Host, TaskContext } from '../types';

export const URL_ANIMATION_MS = 600;

export async function telegraphAddressBar(host: Host, ctx: TaskContext, url: string): Promise<void> {
  const rect = host.browser.toolbarRect('address_bar');
  if (rect) {
    await telegraph(host, ctx, center(rect), `Opening ${new URL(url).hostname}`);
    // Visual only: the URL "appears" in the bar. Never keystrokes.
    host.browser.animateUrl(url, URL_ANIMATION_MS);
    await host.sleep(URL_ANIMATION_MS, ctx.signal);
  }
}

export async function pageAfterLoad(host: Host): Promise<string> {
  return describePage(await host.browser.snapshot());
}
