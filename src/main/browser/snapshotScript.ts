/**
 * In-page snapshot collector (spec section 7, step 1).
 *
 * Runs inside the Chrome page through CDP and returns the DOM/accessibility view
 * the planner is allowed to see: stable ids, roles, accessible names and boxes in
 * page CSS px. It never reads input values, except the main search box (spec
 * section 10).
 *
 * The function is serialized and evaluated in the page, so it must not reference
 * anything from module scope - everything is declared inside the body.
 */

export type RiskKind = 'none' | 'password' | 'payment' | 'personal';

export interface RawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawElement {
  id: string;
  tag: string;
  role: string;
  name: string;
  bbox: RawBox;
  inViewport: boolean;
  isSearchField: boolean;
  fieldRisk: RiskKind;
  formRisk: RiskKind;
  autocomplete?: string;
  order: number;
  textPreview?: string;
}

export interface RawSnapshot {
  url: string;
  title: string;
  scroll: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  elements: RawElement[];
  searchFieldId: string | null;
  /** Only the search box value is ever carried out of the page. */
  searchFieldValue?: string;
  interactiveCount: number;
}

/** Marker attribute used to resolve an element id back to a DOM node. */
export const GC_ID_ATTRIBUTE = 'data-gc-id';

export function collectSnapshot(): RawSnapshot {
  type Risk = 'none' | 'password' | 'payment' | 'personal';

  const selector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="checkbox"]',
    '[role="option"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
  ].join(',');

  const personalAutocomplete = [
    'name',
    'honorific-prefix',
    'given-name',
    'family-name',
    'email',
    'tel',
    'tel-national',
    'address-line1',
    'address-line2',
    'street-address',
    'bday',
    'username',
    'nickname',
    'organization',
  ];

  const riskOf = (element: Element): Risk => {
    const input = element as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase().trim();
    const identity = `${input.name || ''} ${input.id || ''}`.toLowerCase();
    const label = (
      input.getAttribute('aria-label') ||
      input.getAttribute('placeholder') ||
      ''
    ).toLowerCase();

    if (type === 'password' || /password|passwd|passwort/.test(identity + ' ' + label)) {
      return 'password';
    }
    if (
      autocomplete.startsWith('cc-') ||
      /\b(?:card|cvv|cvc|expiry|expire|iban|credit)\b/.test(identity + ' ' + label)
    ) {
      return 'payment';
    }
    if (autocomplete && personalAutocomplete.includes(autocomplete.split(' ')[0])) {
      return 'personal';
    }
    return 'none';
  };

  const worst = (a: Risk, b: Risk): Risk => {
    const rank: Record<Risk, number> = { none: 0, personal: 1, payment: 2, password: 3 };
    return rank[a] >= rank[b] ? a : b;
  };

  const formRiskOf = (element: Element): Risk => {
    const form = element.closest('form') || element.closest('[role="form"]');
    if (!form) return 'none';
    let risk: Risk = 'none';
    const fields = form.querySelectorAll('input, textarea, select');
    for (let i = 0; i < fields.length; i += 1) {
      risk = worst(risk, riskOf(fields[i]));
    }
    return risk;
  };

  const isVisible = (element: Element, rect: DOMRect): boolean => {
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
      // A field can be visually hidden but still be the real search box.
      if ((element as HTMLInputElement).type !== 'search') return false;
    }
    return true;
  };

  const accessibleName = (element: Element): string => {
    const input = element as HTMLInputElement;
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node ? (node.textContent || '').trim() : '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' ').trim();
    }

    if (element.tagName === 'IMG') return (element.getAttribute('alt') || '').trim();
    const title = element.getAttribute('title');
    if (title && title.trim()) return title.trim();

    if (
      element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.tagName === 'SELECT'
    ) {
      const placeholder = element.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label && label.textContent) return label.textContent.trim();
      }
      const wrapped = element.closest('label');
      if (wrapped && wrapped.textContent) return wrapped.textContent.trim();
      // The value of a submit/button input is a label, not user data.
      const type = (input.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return (element.getAttribute('value') || '').trim();
      }
      // Never read .value of a data field.
      return '';
    }

    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'search') return 'searchbox';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
        return 'button';
      }
      return 'textbox';
    }
    if (element.getAttribute('contenteditable') !== null) return 'textbox';
    return tag;
  };

  const looksLikeSearchField = (element: Element, role: string): boolean => {
    const input = element as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    if (type === 'search' || role === 'searchbox') return true;
    const identity = `${input.name || ''} ${input.id || ''}`.toLowerCase();
    if (/(?:^|[\s_-])q(?:$|[\s_-])|query|search/.test(identity)) return true;
    const label = (
      element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      ''
    )
      .toLowerCase()
      .trim();
    if (/^search\b|^suche\b|search the web/.test(label)) return true;
    const form = element.closest('form');
    if (form) {
      const formRole = (form.getAttribute('role') || '').toLowerCase();
      const action = (form.getAttribute('action') || '').toLowerCase();
      if (formRole === 'search' || action.includes('search')) return true;
    }
    return false;
  };

  const view = { width: window.innerWidth, height: window.innerHeight };
  const scoped = window as unknown as { __gcSeq?: number };
  if (typeof scoped.__gcSeq !== 'number') scoped.__gcSeq = 0;

  const nodes = Array.from(document.querySelectorAll(selector));
  const elements: RawElement[] = [];
  const roleCount: Record<string, number> = {};
  let searchId: string | null = null;
  let searchScore = -1;
  let searchValue: string | undefined;

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (!isVisible(node, rect)) continue;

    const role = roleOf(node);
    const isSearch = looksLikeSearchField(node, role);
    scoped.__gcSeq = (scoped.__gcSeq || 0) + 1;
    const id = `e${scoped.__gcSeq}`;
    node.setAttribute('data-gc-id', id);

    roleCount[role] = (roleCount[role] || 0) + 1;
    const element: RawElement = {
      id,
      tag: node.tagName.toLowerCase(),
      role,
      name: accessibleName(node).slice(0, 200),
      bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      inViewport:
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top <= view.height &&
        rect.left <= view.width,
      isSearchField: isSearch,
      fieldRisk: riskOf(node),
      formRisk: formRiskOf(node),
      order: roleCount[role],
    };

    const autocomplete = node.getAttribute('autocomplete');
    if (autocomplete) element.autocomplete = autocomplete;
    if (role === 'link' || role === 'heading') {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) element.textPreview = text.slice(0, 200);
    }
    elements.push(element);

    if (isSearch) {
      // Prefer the main box: a real search input near the top of the page.
      const input = node as HTMLInputElement;
      const identity = `${input.name || ''} ${input.id || ''}`.toLowerCase();
      const area = rect.width * rect.height;
      let score = 0;
      if (/(?:^|[\s_-])q(?:$|[\s_-])/.test(identity)) score += 5;
      if ((input.type || '').toLowerCase() === 'search' || role === 'searchbox') score += 3;
      if (area > 8000) score += 2;
      if (rect.top >= 0 && rect.top < 500) score += 2;
      if (element.inViewport) score += 1;
      if (score > searchScore) {
        searchScore = score;
        searchId = id;
        // The search box is the only field whose value may leave the page.
        searchValue = typeof input.value === 'string' ? input.value : '';
      }
    }
  }

  // Keep the payload bounded: visible elements first, then off-screen ones.
  const capped =
    elements.length > 80
      ? [
          ...elements.filter((element) => element.inViewport),
          ...elements.filter((element) => !element.inViewport),
        ].slice(0, 80)
      : elements;

  const documentElement = document.documentElement;
  const result: RawSnapshot = {
    url: window.location.href,
    title: document.title,
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      width: documentElement.scrollWidth,
      height: documentElement.scrollHeight,
    },
    viewport: view,
    devicePixelRatio: window.devicePixelRatio,
    elements: capped,
    searchFieldId: searchId,
    interactiveCount: nodes.length,
  };
  if (typeof searchValue === 'string') result.searchFieldValue = searchValue;
  return result;
}

/** Resolve a snapshot element id back to a DOM node (used for clicks and typing). */
export function resolveElementId(elementId: string): boolean {
  // The attribute name is inlined: this function is evaluated inside the page and
  // must not reference module-scope runtime values.
  const node = document.querySelector(`[data-gc-id="${elementId}"]`);
  return node !== null;
}


