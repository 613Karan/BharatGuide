/** In-page snapshot collector (spec 6.6). Returns a PageSnapshot (shared/page.ts). */
import { MAX_ELEMENTS, SHARED_HELPERS } from './pageHelpers';

export const SNAPSHOT_SCRIPT = String.raw`(() => {
  ${SHARED_HELPERS}
  const SELECTOR = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=searchbox],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true],h1,h2,h3';
  const vw = window.innerWidth, vh = window.innerHeight;
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-3]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return el.isContentEditable ? 'textbox' : tag;
  };
  const nameOf = (el) => {
    const label = labelOf(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(el.value);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    const img = el.querySelector && el.querySelector('img[alt]');
    const text = clean(el.innerText || el.textContent);
    return clean(text || el.getAttribute('title') || (img && img.getAttribute('alt')) || el.getAttribute('placeholder'));
  };
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  window.__ggSeq = window.__ggSeq || 0;
  const all = [];
  const roleCount = {};
  let searchId = null, searchScore = -1, searchValue;
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    let id = el.getAttribute('data-gg-id');
    if (!id) { window.__ggSeq += 1; id = 'e' + window.__ggSeq; el.setAttribute('data-gg-id', id); }
    const role = roleOf(el);
    roleCount[role] = (roleCount[role] || 0) + 1;
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    const isSearch = isSearchField(el);
    const sensitive = fieldSensitive(el) || formSensitive(el);
    all.push({ id, role, name: nameOf(el).slice(0, 100),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      inViewport, sensitive, isSearch, order: roleCount[role] });
    if (isSearch) {
      let score = 0;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'search' || role === 'searchbox') score += 3;
      if (/(^|[\s_-])(q|search_query)($|[\s_-])/.test(((el.getAttribute('name') || '') + ' ' + el.id).toLowerCase())) score += 4;
      if (r.width * r.height > 8000) score += 2;
      if (r.top >= 0 && r.top < 400) score += 2;
      if (inViewport) score += 1;
      if (score > searchScore) { searchScore = score; searchId = id; searchValue = typeof el.value === 'string' ? el.value : clean(el.textContent); }
    }
  }
  const ordered = all.filter((e) => e.inViewport).concat(all.filter((e) => !e.inViewport));
  const elements = ordered.slice(0, ${MAX_ELEMENTS});
  if (searchId && !elements.some((e) => e.id === searchId)) {
    const s = all.find((e) => e.id === searchId);
    if (s) elements[elements.length - 1] = s;
  }
  const out = { url: location.href, title: document.title, scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight, viewport: { width: vw, height: vh }, elements, searchFieldId: searchId };
  if (searchId) out.searchValue = String(searchValue || '').slice(0, 200);
  return out;
})()`;
