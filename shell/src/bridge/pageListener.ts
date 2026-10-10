/**
 * Page listener (spec 6.6). Installed with Page.addScriptToEvaluateOnNewDocument
 * into an isolated world so page JS cannot call the binding, and it survives
 * navigation. Reports what the USER did (isTrusted events only); the only value
 * it ever reports is the search box value.
 */
import { BINDING_NAME, SHARED_HELPERS } from './pageHelpers';

export const LISTENER_SCRIPT = String.raw`(() => {
  if (window.__ggListener) return;
  window.__ggListener = true;
  ${SHARED_HELPERS}
  const send = (p) => { try { if (typeof ${BINDING_NAME} === 'function') ${BINDING_NAME}(JSON.stringify(Object.assign({ at: Date.now(), url: location.href }, p))); } catch (e) {} };
  const describe = (t) => {
    if (!(t instanceof Element)) return {};
    const el = t.closest('[data-gg-id]') || t;
    const out = { elementId: el.getAttribute('data-gg-id'),
      name: clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent).slice(0, 80) };
    if (isSearchField(el)) { out.isSearch = true; out.value = String(el.value || '').slice(0, 200); }
    return out;
  };
  document.addEventListener('focusin', (e) => send(Object.assign({ type: 'focus' }, describe(e.target))), true);
  document.addEventListener('click', (e) => { if (e.isTrusted) send(Object.assign({ type: 'click' }, describe(e.target))); }, true);
  let inputTimer = 0;
  document.addEventListener('input', (e) => { clearTimeout(inputTimer); const d = describe(e.target); inputTimer = setTimeout(() => send(Object.assign({ type: 'input' }, d)), 250); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.isTrusted) send({ type: 'escape' }); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => send({ type: 'navigation' }));
  else send({ type: 'navigation' });
})()`;
