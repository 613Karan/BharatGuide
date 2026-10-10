/**
 * JS helper source shared by every script evaluated in the page. Plain strings
 * so bundling never rewrites them. Read-only: nothing here synthesizes input.
 */
import { SENSITIVE_AUTOCOMPLETE_SOURCE, SENSITIVE_NAME_SOURCE } from './sensitive';

export const BINDING_NAME = '__ggReport';
export const ISOLATED_WORLD = 'gg-listener';
export const MAX_ELEMENTS = 60;

export const SHARED_HELPERS = String.raw`
  const NAME_RE = new RegExp(${JSON.stringify(SENSITIVE_NAME_SOURCE)}, 'i');
  const AC_RE = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_SOURCE)}, 'i');
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) parts.push(n.textContent); });
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.textContent); } catch (e) {} }
    const wrap = el.closest && el.closest('label');
    if (wrap) parts.push(wrap.textContent);
    return clean(parts.join(' '));
  };
  const isField = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || role === 'textbox' || el.isContentEditable;
  };
  const fieldSensitive = (el) => {
    if (!isField(el)) return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (AC_RE.test((el.getAttribute('autocomplete') || '').trim())) return true;
    const identity = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), labelOf(el)].filter(Boolean).join(' ');
    return NAME_RE.test(identity);
  };
  const formSensitive = (el) => {
    const form = el.closest && el.closest('form');
    if (!form) return false;
    if (form.__ggSens === undefined) {
      form.__ggSens = Array.from(form.querySelectorAll('input,textarea,select,[role=textbox],[contenteditable]')).some(fieldSensitive);
    }
    return form.__ggSens;
  };
  const isSearchField = (el) => {
    if (!isField(el) || fieldSensitive(el)) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (type === 'search' || role === 'searchbox') return true;
    if (role === 'combobox' && /search/i.test(el.getAttribute('aria-label') || '')) return true;
    const identity = ((el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
    if (/(^|[\s_-])(q|query|search|search_query)($|[\s_-])/.test(identity)) return true;
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toLowerCase().trim();
    return /^search\b/.test(label);
  };
  const byGgId = (id) => document.querySelector('[data-gg-id="' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
`;

/** Fresh rect for one element: { found, rect, inViewport, sensitive, isSearch }. */
export function elementInfoScript(elementId: string): string {
  return `(() => {
    ${SHARED_HELPERS}
    const el = byGgId(${JSON.stringify(elementId)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    return { found: true, rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
      sensitive: fieldSensitive(el) || formSensitive(el), isSearch: isSearchField(el) };
  })()`;
}

/** Focus the granted search field and clear it so insertText types exactly the title. */
export function focusSearchScript(elementId: string): string {
  return `(() => {
    const el = document.querySelector('[data-gg-id="' + ${JSON.stringify(elementId)}.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    if (!el) return false;
    el.focus();
    if (typeof el.value === 'string' && el.value !== '') {
      el.select && el.select();
    }
    return document.activeElement === el;
  })()`;
}

export function searchValueScript(elementId: string): string {
  return `(() => {
    const el = document.querySelector('[data-gg-id="' + ${JSON.stringify(elementId)}.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    return el ? String(el.value === undefined ? el.textContent : el.value) : null;
  })()`;
}
