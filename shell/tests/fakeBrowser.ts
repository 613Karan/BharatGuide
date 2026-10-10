/** Fake BrowserPort + GhostPort for tests. No Electron. */
import type { ElementInfo } from '../src/bridge/cdp';
import type { GhostRect, TabInfo } from '../src/shared/ipc';
import type { PageEvent, PageSnapshot, SnapElement } from '../src/shared/page';
import type { BrowserPort, Point, WaitEvent } from '../src/agent/types';

const el = (id: string, role: string, name: string, y: number, extra: Partial<SnapElement> = {}): SnapElement => ({
  id, role, name, rect: { x: 100, y, width: 200, height: 40 }, inViewport: true, sensitive: false, isSearch: false, order: 1, ...extra,
});

export const SEARCH_BOX = el('e1', 'searchbox', 'Search', 20, { isSearch: true });
export const REGISTER_BTN = el('e2', 'button', 'Register as new elector', 200);
export const OTP_FIELD = el('e3', 'textbox', 'Enter OTP', 300, { sensitive: true });

export function snapshot(elements: SnapElement[] = [SEARCH_BOX, REGISTER_BTN, OTP_FIELD]): PageSnapshot {
  return {
    url: 'https://www.youtube.com/', title: 'Page', scrollY: 0, scrollHeight: 2000,
    viewport: { width: 1000, height: 700 }, elements, searchFieldId: elements.find((e) => e.isSearch)?.id ?? null,
  };
}

export class FakeBrowser implements BrowserPort {
  snap: PageSnapshot | null = snapshot();
  actions: string[] = [];
  typed: string[] = [];
  tabs: TabInfo[] = [{ id: 't1', title: 'Voter portal', url: 'https://voters.eci.gov.in/', loading: false }];
  active: string | null = 't1';
  nextEvent: PageEvent | null = { type: 'click', at: 0, elementId: 'e2' };

  async snapshot() { return this.snap; }
  async elementInfo(id: string): Promise<ElementInfo> {
    const e = this.snap?.elements.find((x) => x.id === id);
    return e ? { found: true, rect: e.rect, inViewport: e.inViewport, sensitive: e.sensitive, isSearch: e.isSearch } : { found: false };
  }
  pageOrigin(): Point { return { x: 0, y: 84 }; }
  pageSize() { return { width: 1000, height: 700 }; }
  toolbarRect(id: string): GhostRect | null {
    if (id === 'address_bar') return { id, x: 120, y: 44, width: 600, height: 32 };
    if (id.startsWith('tab:')) return { id, x: 10, y: 6, width: 180, height: 34 };
    return null;
  }
  listTabs() { return this.tabs; }
  activeTabId() { return this.active; }
  maxTabs() { return 6; }
  async openTab(url: string) {
    this.actions.push(`open_tab:${url}`);
    const id = `t${this.tabs.length + 1}`;
    this.tabs.push({ id, title: url, url, loading: false });
    this.active = id;
    return id;
  }
  switchTab(id: string) { this.actions.push(`switch:${id}`); this.active = id; }
  async navigate(url: string) { this.actions.push(`navigate:${url}`); }
  animateUrl(url: string) { this.actions.push(`animate:${url}`); }
  async click(x: number, y: number) { this.actions.push(`click:${x},${y}`); }
  async wheel(_x: number, _y: number, dy: number) { this.actions.push(`wheel:${dy}`); }
  /** false = simulate a page that refuses to scroll (element stays off screen). */
  canScroll = true;
  async scrollIntoView(id: string) {
    this.actions.push(`scroll_into_view:${id}`);
    const snap = this.snap;
    const e = snap?.elements.find((x) => x.id === id);
    if (!snap || !e || !this.canScroll) return Boolean(e);
    // Replace with a copy: element fixtures are shared module constants across tests.
    const moved = { ...e, rect: { ...e.rect, y: 300 }, inViewport: true };
    this.snap = { ...snap, elements: snap.elements.map((x) => (x.id === id ? moved : x)) };
    return true;
  }
  async focusSearch() { return true; }
  async insertText(text: string) { this.typed.push(text); }
  async searchValue() { return this.typed.at(-1) ?? ''; }
  async pressEnter() { this.actions.push('enter'); }
  async waitForEvent(_event: WaitEvent) { return this.nextEvent; }
}

export class FakeGhost {
  alive = true;
  log: string[] = [];
  move(x: number, y: number) { this.log.push(`move:${Math.round(x)},${Math.round(y)}`); }
  pulse() { this.log.push('pulse'); }
  ripple() { this.log.push('ripple'); }
  hint(text: string) { this.log.push(`hint:${text}`); }
  hide() { this.log.push('hide'); }
}
