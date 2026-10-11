import puppeteer from 'puppeteer-core';
import type { Browser, CDPSession, ElementHandle, Page } from 'puppeteer-core';
import { ELEMENT_POVERTY_THRESHOLD } from '../../shared/types';
import type {
  BrowserGeometry,
  PageSnapshot,
  ScrollDirection,
  SnapshotElement,
  WaitForEvent,
} from '../../shared/types';
import { buildGeometry, calibrationOk } from './coordinates';
import { installPageListener } from './listenerScript';
import type { PageEvent } from './listenerScript';
import { collectSnapshot } from './snapshotScript';
import type { RawSnapshot } from './snapshotScript';

/**
 * Browser bridge (spec section 4).
 *
 * Snapshot, click, scroll and guarded type, all over CDP. This module is the only
 * place that touches the page, and everything it does is a CDP protocol message:
 * no OS-level input, no synthetic cursor movement (spec section 2, rule 1).
 */

export interface BridgeOptions {
  browserWSEndpoint: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export type PageEventHandler = (event: PageEvent) => void;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ActionResult {
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export class BrowserBridge {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private session: CDPSession | null = null;
  private windowId: number | null = null;
  private handlers: PageEventHandler[] = [];
  private waitCancellers: Array<() => void> = [];
  private lastSnapshot: PageSnapshot | null = null;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;

  constructor(options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
    this.endpoint = options.browserWSEndpoint;
  }

  private readonly endpoint: string;

  get isConnected(): boolean {
    return this.browser !== null && this.page !== null;
  }

  get currentPage(): Page | null {
    return this.page;
  }

  get latestSnapshot(): PageSnapshot | null {
    return this.lastSnapshot;
  }

  /** Every page event the injected listener reports. */
  onPageEvent(handler: PageEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  private emit(event: PageEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.log('page event handler failed', { error: String(error) });
      }
    }
  }

  async connect(): Promise<void> {
    // defaultViewport: null keeps the real window size, which the coordinate
    // mapping depends on.
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.endpoint,
      defaultViewport: null,
    });
    this.page = await this.pickPage();
    await this.instrument(this.page);

    // Chrome opens new tabs; follow the newest page so the ghost stays useful.
    this.browser.on('targetcreated', (target) => {
      void (async () => {
        try {
          if (target.type() !== 'page') return;
          const page = await target.page();
          if (!page || page === this.page) return;
          this.page = page;
          this.session = null;
          await this.instrument(page);
          this.log('bridge attached to a new page', { url: page.url() });
        } catch (error) {
          this.log('could not attach to new page', { error: String(error) });
        }
      })();
    });
  }

  private async pickPage(): Promise<Page> {
    const browser = this.browser;
    if (!browser) throw new Error('bridge is not connected');
    const pages = await browser.pages();
    const usable = pages.filter((page) => !page.url().startsWith('devtools://'));
    if (usable.length > 0) return usable[usable.length - 1];
    return browser.newPage();
  }

  /** Install the one-way report binding and the page listener. */
  private async instrument(page: Page): Promise<void> {
    try {
      await page.exposeFunction('__ghostReport', (payload: unknown) => {
        this.emit(payload as PageEvent);
      });
    } catch {
      // Already exposed on this page (re-instrumentation after a crash).
    }
    await page.evaluateOnNewDocument(installPageListener);
    try {
      await page.evaluate(installPageListener);
    } catch (error) {
      this.log('listener install failed', { error: String(error) });
    }
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.emit({ type: 'navigation', at: Date.now(), url: frame.url() });
      }
    });
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('bridge has no page: call connect() first');
    return this.page;
  }

  private async sessionFor(page: Page): Promise<CDPSession> {
    if (this.session) return this.session;
    this.session = await page.createCDPSession();
    return this.session;
  }

  /** Perceive: URL, title, scroll position and visible interactive elements. */
  async snapshot(): Promise<PageSnapshot> {
    const page = this.requirePage();
    const raw: RawSnapshot = await page.evaluate(collectSnapshot);
    const elements: SnapshotElement[] = raw.elements.map((element) => ({
      id: element.id,
      tag: element.tag,
      role: element.role,
      name: element.name,
      bbox: element.bbox,
      inViewport: element.inViewport,
      isSearchField: element.isSearchField,
      fieldRisk: element.fieldRisk,
      formRisk: element.formRisk,
      autocomplete: element.autocomplete,
      order: element.order,
      textPreview: element.textPreview,
    }));

    const snapshot: PageSnapshot = {
      snapshotId: `s${Date.now().toString(36)}`,
      url: raw.url,
      title: raw.title,
      scroll: raw.scroll,
      viewport: raw.viewport,
      devicePixelRatio: raw.devicePixelRatio,
      elements,
      searchFieldId: raw.searchFieldId,
      searchFieldValue: raw.searchFieldValue,
      needsScreenshotFallback: elements.length < ELEMENT_POVERTY_THRESHOLD,
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Page CSS px -> screen DIP mapping for the current Chrome window. */
  async geometry(): Promise<BrowserGeometry> {
    const page = this.requirePage();
    const session = await this.sessionFor(page);
    const target = (await session.send('Browser.getWindowForTarget')) as {
      windowId: number;
    };
    this.windowId = target.windowId;
    const boundsResult = (await session.send('Browser.getWindowBounds', {
      windowId: target.windowId,
    })) as {
      bounds: { left: number; top: number; width: number; height: number };
    };
    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      devicePixelRatio: window.devicePixelRatio,
    }));
    return buildGeometry(boundsResult.bounds, metrics);
  }

  /**
   * Startup calibration (spec section 14): compare the two mapping methods and
   * report whether they agree. Recompute after every scroll or resize by simply
   * calling `geometry()` again - it never caches.
   */
  async calibrate(): Promise<{ geometry: BrowserGeometry; ok: boolean; delta: number }> {
    const geometry = await this.geometry();
    const ok = calibrationOk(geometry);
    this.log('coordinate calibration', {
      ok,
      delta: geometry.crossCheckDelta,
      scale: geometry.scale,
      viewportTop: geometry.viewportTop,
    });
    return { geometry, ok, delta: geometry.crossCheckDelta };
  }

  /** Center of an element in viewport CSS px, or null when it is gone. */
  async elementCenter(elementId: string): Promise<{ x: number; y: number } | null> {
    const page = this.requirePage();
    const handle = await page.$(`[data-gc-id="${elementId}"]`);
    if (!handle) return null;
    const box = await handle.boundingBox();
    if (!box) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /**
   * Act: click an element through CDP `Input.dispatchMouseEvent`.
   * The 400 ms telegraph happens in the agent core before this call.
   */
  async click(elementId: string): Promise<ActionResult> {
    const page = this.requirePage();
    const handle = await page.$(`[data-gc-id="${elementId}"]`);
    if (!handle) {
      return { ok: false, reason: `element ${elementId} is no longer on the page` };
    }
    try {
      await handle.evaluate((element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      });
    } catch {
      // Not supported everywhere; the bounding box below still tells the truth.
    }
    await sleep(60);
    const box = await handle.boundingBox();
    if (!box) return { ok: false, reason: 'element has no visible box' };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    this.log('cdp click dispatched', { elementId, x: Math.round(x), y: Math.round(y) });
    return { ok: true, detail: { elementId, x, y } };
  }

  /**
   * Act: mouse wheel over the page, at most one screen height per call
   * (spec section 8). `top`/`bottom` repeat single screens until the page stops.
   */
  async scroll(direction: ScrollDirection, amount?: number): Promise<ActionResult> {
    const page = this.requirePage();
    const view = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const oneScreen = Math.max(100, Math.round(view.height));
    const step = Math.min(Math.max(1, Math.round(amount ?? oneScreen)), oneScreen);

    // Park the CDP mouse over the content so the wheel event lands on the page.
    await page.mouse.move(Math.round(view.width / 2), Math.round(view.height / 2));

    if (direction === 'down' || direction === 'up') {
      const deltaY = direction === 'down' ? step : -step;
      await page.mouse.wheel({ deltaY });
      await sleep(150);
      const y = await page.evaluate(() => window.scrollY);
      this.log('cdp scroll dispatched', { direction, deltaY, scrollY: y });
      return { ok: true, detail: { deltaY, scrollY: y } };
    }

    const sign = direction === 'top' ? -1 : 1;
    let previous = -1;
    let steps = 0;
    for (let i = 0; i < 20; i += 1) {
      const y = await page.evaluate(() => window.scrollY);
      if (y === previous) break;
      previous = y;
      await page.mouse.wheel({ deltaY: sign * oneScreen });
      steps += 1;
      await sleep(140);
    }
    const finalY = await page.evaluate(() => window.scrollY);
    this.log('cdp scroll dispatched', { direction, steps, scrollY: finalY });
    return { ok: true, detail: { steps, scrollY: finalY } };
  }

  /**
   * Act: guarded typing (spec section 8). Defense in depth: the target is
   * re-checked inside the page immediately before any key event, so even a stale
   * snapshot cannot turn this into typing into a password or payment field.
   */
  async typeInSearch(text: string, expectedFieldId: string): Promise<ActionResult> {
    const page = this.requirePage();

    const check = await page.evaluate((elementId: string) => {
      const node = document.querySelector(`[data-gc-id="${elementId}"]`) as
        | HTMLInputElement
        | null;
      if (!node) return { found: false, isSearch: false, risk: 'none', tag: '', editable: false };
      const type = (node.type || '').toLowerCase();
      const role = (node.getAttribute('role') || '').toLowerCase();
      const identity = `${node.name || ''} ${node.id || ''}`.toLowerCase();
      const label = `${node.getAttribute('aria-label') || ''} ${
        node.getAttribute('placeholder') || ''
      }`.toLowerCase();
      const autocomplete = (node.getAttribute('autocomplete') || '').toLowerCase();

      let isSearch = false;
      if (type === 'search' || role === 'searchbox') isSearch = true;
      else if (/(?:^|[\s_-])q(?:$|[\s_-])|query|search/.test(identity)) isSearch = true;
      else if (/^search\b|^suche\b|search the web/.test(label.trim())) isSearch = true;
      else {
        const form = node.closest('form');
        if (form) {
          const formRole = (form.getAttribute('role') || '').toLowerCase();
          const action = (form.getAttribute('action') || '').toLowerCase();
          if (formRole === 'search' || action.includes('search')) isSearch = true;
        }
      }

      let risk = 'none';
      if (type === 'password' || /password|passwd|passwort/.test(`${identity} ${label}`)) {
        risk = 'password';
      } else if (
        autocomplete.startsWith('cc-') ||
        /\b(?:card|cvv|cvc|expiry|expire|iban|credit)\b/.test(`${identity} ${label}`)
      ) {
        risk = 'payment';
      } else if (
        [
          'name',
          'given-name',
          'family-name',
          'email',
          'tel',
          'address-line1',
          'street-address',
          'bday',
          'username',
          'nickname',
          'organization',
        ].includes(autocomplete.split(' ')[0])
      ) {
        risk = 'personal';
      }

      const tag = node.tagName.toLowerCase();
      const editable =
        tag === 'input' || tag === 'textarea' || node.getAttribute('contenteditable') !== null;
      return { found: true, isSearch, risk, tag, editable };
    }, expectedFieldId);

    if (!check.found) return { ok: false, reason: 'the search field is no longer on the page' };
    if (!check.isSearch) {
      return { ok: false, reason: 'target is not the main search field of this page' };
    }
    if (check.risk !== 'none') {
      return { ok: false, reason: `refusing to type into a ${check.risk} field` };
    }
    if (!check.editable) {
      return { ok: false, reason: `target <${check.tag}> is not editable` };
    }

    const handle: ElementHandle<Element> | null = await page.$(
      `[data-gc-id="${expectedFieldId}"]`,
    );
    if (!handle) return { ok: false, reason: 'the search field could not be resolved' };

    /** What the page itself says the field contains - the only truth we accept. */
    const readValue = (): Promise<string> =>
      handle.evaluate((node) => {
        const field = node as HTMLInputElement | HTMLTextAreaElement;
        return typeof field.value === 'string' ? field.value : '';
      });

    await handle.focus();
    // Clear whatever is already there, then type the granted title exactly once.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press('KeyA');
    await page.keyboard.up(modifier);
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 25 });

    let value = await readValue();
    let method = 'key-events';
    if (value !== text) {
      // A minimized or fully covered Chrome window can drop synthetic key events.
      // Recovery stays inside CDP: activate the tab, re-focus the field, clear it and
      // insert the granted title with Input.insertText. Nothing touches the OS.
      this.log('cdp typing did not reach the field, retrying with Input.insertText', {
        elementId: expectedFieldId,
        observed: value,
      });
      await page.bringToFront().catch(() => undefined);
      await handle.focus();
      await handle.evaluate((node) => {
        const field = node as HTMLInputElement | HTMLTextAreaElement;
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const session = await this.sessionFor(page);
      await session.send('Input.insertText', { text });
      value = await readValue();
      method = 'input-insert-text';
    }

    this.log('cdp typing finished', { elementId: expectedFieldId, length: text.length, method });
    if (value !== text) {
      // Honest failure: the agent loop drops the grant and tells the user.
      return {
        ok: false,
        reason: 'the page did not accept the typed text',
        detail: { elementId: expectedFieldId, expected: text, observed: value },
      };
    }
    return {
      ok: true,
      detail: { elementId: expectedFieldId, characters: text.length, method },
    };
  }

  /** Act: submit the search. Only ever called right after a granted type. */
  async pressEnter(): Promise<ActionResult> {
    const page = this.requirePage();
    const navigation = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press('Enter');
    const navigated = await navigation;
    this.log('cdp enter dispatched', { navigated });
    return { ok: true, detail: { navigated } };
  }

  /** Wait for the user: resolved by the page listener, null on timeout or cancel. */
  waitForPageEvent(event: WaitForEvent, timeoutMs: number): Promise<PageEvent | null> {
    return new Promise((resolve) => {
      let settled = false;
      const remove = (): void => {
        this.handlers = this.handlers.filter((candidate) => candidate !== handler);
      };
      const finish = (value: PageEvent | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        remove();
        this.waitCancellers = this.waitCancellers.filter((candidate) => candidate !== cancel);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const cancel = (): void => finish(null);

      const handler = (pageEvent: PageEvent): void => {
        const wanted =
          event === 'any'
            ? pageEvent.type === 'focus' ||
              pageEvent.type === 'click' ||
              pageEvent.type === 'input' ||
              pageEvent.type === 'navigation'
            : pageEvent.type === event;
        if (!wanted) return;
        finish(pageEvent);
      };
      this.handlers.push(handler);
      this.waitCancellers.push(cancel);
    });
  }

  /**
   * End every pending wait at once (Escape, halt, shutdown). Without this a stop
   * request would only be noticed after the wait had timed out by itself, which
   * would leave the ghost "waiting" for up to a minute after the user said stop.
   */
  cancelWaits(): void {
    const cancellers = this.waitCancellers;
    this.waitCancellers = [];
    for (const cancel of cancellers) cancel();
  }

  /** Give focus back to Chrome after the dialog was used. */
  async bringChromeToFront(): Promise<void> {
    try {
      await this.requirePage().bringToFront();
    } catch (error) {
      this.log('could not bring Chrome to front', { error: String(error) });
    }
  }

  async currentUrl(): Promise<string> {
    try {
      return this.requirePage().url();
    } catch {
      return '';
    }
  }

  /** Detach from Chrome. The browser process itself is closed by the launcher. */
  async disconnect(): Promise<void> {
    this.cancelWaits();
    this.handlers = [];
    if (this.session) {
      try {
        await this.session.detach();
      } catch {
        // Already gone.
      }
      this.session = null;
    }
    if (this.browser) {
      try {
        await this.browser.disconnect();
      } catch {
        // Already gone.
      }
      this.browser = null;
    }
    this.page = null;
    this.windowId = null;
  }

  /**
   * Navigate to a normal http(s) page (used only to open the configured start
   * page when Chrome launched on an internal page). Never navigates by itself
   * during a task: only the user can decide to leave a page (spec section 16).
   */
  async navigate(url: string): Promise<ActionResult> {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'only normal http(s) pages may be opened by the agent' };
    }
    try {
      await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(300);
      this.log('page opened', { url });
      return { ok: true, detail: { url } };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }
}





