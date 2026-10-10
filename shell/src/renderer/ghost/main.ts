/**
 * Ghost overlay renderer (spec 6.2). Draws only: arrow, trail, ring, ripple,
 * hint. Curved ease-in-out path; duration is decided by main (300-900 ms).
 * Coordinates are overlay-local CSS px (== DIP of the main window content).
 */
import type { OverlayCommand } from '../../shared/ipc';
import type { GhostApi } from '../../preload/ghost';

declare global {
  interface Window {
    ghost: GhostApi;
  }
}

const canvas = document.getElementById('trail') as HTMLCanvasElement;
const ctx2d = canvas.getContext('2d')!;
const cursor = document.getElementById('cursor')!;
const ring = document.getElementById('ring')!;
const ripples = document.getElementById('ripples')!;
const hint = document.getElementById('hint')!;

type Move = { sx: number; sy: number; mx: number; my: number; tx: number; ty: number; t0: number; ms: number };
const state = { x: window.innerWidth / 2, y: window.innerHeight / 2, move: null as Move | null, trail: [] as { x: number; y: number; at: number }[], hintTimer: 0 };

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(innerHeight * dpr));
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function place(x: number, y: number): void {
  state.x = x;
  state.y = y;
  cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function show(): void {
  cursor.classList.remove('hidden');
}

function restart(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function pulse(x: number, y: number): void {
  if (!state.move) place(x, y);
  show();
  ring.classList.remove('hidden');
  restart(cursor, 'pulse');
  restart(ring, 'beat');
}

function ripple(x: number, y: number): void {
  const node = document.createElement('div');
  node.className = 'ripple';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  ripples.appendChild(node);
  setTimeout(() => node.remove(), 900);
}

function showHint(text: string, x: number, y: number): void {
  hint.textContent = text;
  hint.classList.remove('hidden');
  const w = Math.min(320, hint.offsetWidth || 240);
  const left = x + 24 + w > innerWidth ? x - w - 18 : x + 24;
  const top = Math.min(Math.max(8, y + 18), innerHeight - 60);
  hint.style.transform = `translate3d(${Math.max(8, left)}px, ${top}px, 0)`;
  clearTimeout(state.hintTimer);
  state.hintTimer = window.setTimeout(() => hint.classList.add('hidden'), 6000);
}

function moveTo(tx: number, ty: number, ms: number): void {
  const sx = state.x;
  const sy = state.y;
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.min(140, dist * 0.25);
  state.move = { sx, sy, mx: (sx + tx) / 2 - (dy / dist) * bend, my: (sy + ty) / 2 + (dx / dist) * bend, tx, ty, t0: performance.now(), ms: Math.max(120, ms) };
  cursor.classList.remove('idle');
  ring.classList.add('hidden');
  hint.classList.add('hidden');
  show();
}

function hideAll(): void {
  cursor.classList.add('hidden');
  ring.classList.add('hidden');
  hint.classList.add('hidden');
  state.move = null;
  state.trail = [];
}

function frame(now: number): void {
  const m = state.move;
  if (m) {
    const t = Math.min(1, (now - m.t0) / m.ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const i = 1 - e;
    const x = i * i * m.sx + 2 * i * e * m.mx + e * e * m.tx;
    const y = i * i * m.sy + 2 * i * e * m.my + e * e * m.ty;
    place(x, y);
    state.trail.push({ x, y, at: now });
    if (t >= 1) {
      state.move = null;
      ring.classList.remove('hidden');
      cursor.classList.add('idle');
    }
  }
  ctx2d.clearRect(0, 0, innerWidth, innerHeight);
  state.trail = state.trail.filter((p) => now - p.at < 600);
  for (let k = 1; k < state.trail.length; k += 1) {
    const age = (now - state.trail[k].at) / 600;
    ctx2d.strokeStyle = `rgba(124, 92, 255, ${(0.55 * (1 - age)).toFixed(3)})`;
    ctx2d.lineWidth = Math.max(1, 4 * (1 - age));
    ctx2d.lineCap = 'round';
    ctx2d.beginPath();
    ctx2d.moveTo(state.trail[k - 1].x, state.trail[k - 1].y);
    ctx2d.lineTo(state.trail[k].x, state.trail[k].y);
    ctx2d.stroke();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function handle(c: OverlayCommand): void {
  switch (c.t) {
    case 'move':
      moveTo(c.x, c.y, c.ms);
      break;
    case 'pulse':
      pulse(c.x, c.y);
      break;
    case 'ripple':
      ripple(c.x, c.y);
      break;
    case 'hint':
      showHint(c.text, c.x, c.y);
      break;
    case 'hide':
      hideAll();
      break;
  }
}

window.ghost.onCommand(handle);
window.ghost.startHeartbeat();
