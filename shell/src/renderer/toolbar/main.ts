/**
 * Toolbar renderer (spec 6.4): tab strip + back/forward/reload + address bar.
 * The user uses it normally with their own mouse/keyboard. It reports rects of
 * [data-ghost-id] elements so the ghost can point at tabs and the address bar.
 */
import type { ToolbarState } from '../../shared/ipc';
import type { ToolbarApi } from '../../preload/toolbar';

declare global {
  interface Window {
    browserBar: ToolbarApi;
  }
}

const api = window.browserBar;
const tabsEl = document.getElementById('tabs')!;
const address = document.getElementById('address') as HTMLInputElement;
const back = document.getElementById('back') as HTMLButtonElement;
const forward = document.getElementById('forward') as HTMLButtonElement;
let current: ToolbarState = { tabs: [], activeId: null, canGoBack: false, canGoForward: false };
let animating = false;

function render(state: ToolbarState): void {
  current = state;
  tabsEl.textContent = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.id === state.activeId ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
    el.dataset.ghostId = `tab:${tab.id}`;
    el.title = tab.url;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url || 'New tab';
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    // Close on mousedown and stop it here: the tab's own mousedown (switch) used
    // to fire first, re-render the strip and destroy this button before 'click'.
    close.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.send({ t: 'close', id: tab.id });
    });
    el.append(title, close);
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.close')) return;
      if (e.button === 1) api.send({ t: 'close', id: tab.id }); // middle-click closes, like a browser
      else if (e.button === 0) api.send({ t: 'switch', id: tab.id });
    });
    el.addEventListener('auxclick', (e) => e.preventDefault());
    tabsEl.appendChild(el);
  }
  if (state.tabs.length < 6) {
    const plus = document.createElement('button');
    plus.className = 'newtab';
    plus.dataset.ghostId = 'new_tab';
    plus.textContent = '+';
    plus.title = 'New tab';
    plus.addEventListener('click', () => api.send({ t: 'new_tab' }));
    tabsEl.appendChild(plus);
  }
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!animating && document.activeElement !== address) address.value = active?.url ?? '';
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  requestAnimationFrame(reportRects);
}

function reportRects(): void {
  const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-ghost-id]')).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.ghostId!, x: r.left, y: r.top, width: r.width, height: r.height };
  });
  api.reportRects(rects);
}

/** Visual only: the URL appears letter by letter. Nothing is typed into any page. */
function animateUrl(url: string, ms: number): void {
  animating = true;
  address.classList.add('animating');
  const steps = Math.max(1, Math.min(url.length, 40));
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    address.value = url.slice(0, Math.ceil((url.length * i) / steps));
    if (i >= steps) {
      clearInterval(timer);
      setTimeout(() => {
        animating = false;
        address.classList.remove('animating');
        render(current);
      }, 300);
    }
  }, Math.max(8, ms / steps));
}

document.getElementById('addr-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  if (address.value.trim()) api.send({ t: 'navigate', url: address.value.trim() });
  address.blur();
});
address.addEventListener('focus', () => address.select());
back.addEventListener('click', () => api.send({ t: 'back' }));
forward.addEventListener('click', () => api.send({ t: 'forward' }));
document.getElementById('reload')!.addEventListener('click', () => api.send({ t: 'reload' }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.send({ t: 'esc' });
  // Ctrl+W closes the active tab (only when the address bar is not being edited).
  if (e.ctrlKey && e.key.toLowerCase() === 'w' && current.activeId && document.activeElement !== address) {
    e.preventDefault();
    api.send({ t: 'close', id: current.activeId });
  }
});
addEventListener('resize', reportRects);

api.onState(render);
api.onFx((fx) => animateUrl(fx.url, fx.ms));
api.ready();
