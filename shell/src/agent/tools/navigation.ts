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

/**
 * Snapshot after a load. Single-page portals (voters.eci.gov.in) fire "load"
 * before their app renders the links, so wait until the element count stops
 * growing (max ~6 s) instead of describing a near-empty page.
 */
export async function pageAfterLoad(host: Host, signal?: AbortSignal): Promise<string> {
  let snap = await host.browser.snapshot();
  let last = snap?.elements.length ?? 0;
  for (let i = 0; i < 12; i += 1) {
    if (last >= 15 && i >= 2) break; // enough content and stable for a moment
    await host.sleep(500, signal);
    const next = await host.browser.snapshot();
    const count = next?.elements.length ?? 0;
    snap = next ?? snap;
    if (count === last && count >= 5 && i >= 3) break;
    last = count;
  }
  return describePage(snap);
}
