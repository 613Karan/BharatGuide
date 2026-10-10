/**
 * Ghost overlay renderer.
 *
 * Draws only: the ghost cursor, its arc trail, the target ring, ripples and
 * hints. This window is click-through and never focused, so the user's real
 * mouse and keyboard are never touched (spec section 2, rule 1).
 *
 * Coordinates arrive from main already converted to overlay-local DIP, which
 * equals CSS px in this window, so they can be used directly.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('trail');
  const ctx = canvas.getContext('2d');
  const cursorEl = document.getElementById('cursor');
  const ringEl = document.getElementById('ring');
  const rippleLayer = document.getElementById('rippleLayer');
  const hintEl = document.getElementById('hint');
  const thinkingEl = document.getElementById('thinking');
  const offscreenEl = document.getElementById('offscreen');
  const offscreenArrow = document.getElementById('offscreenArrow');
  const offscreenText = document.getElementById('offscreenText');

  const TRAIL_LIFE_MS = 620;
  const HINT_LIFE_MS = 5000;

  const state = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    move: null,
    trail: [],
    hintTimer: 0,
    offscreenTimer: 0,
    pulseTimer: 0,
  };

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function placeCursor(x, y) {
    state.x = x;
    state.y = y;
    cursorEl.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
    ringEl.style.left = x + 'px';
    ringEl.style.top = y + 'px';
  }

  function showCursor() {
    cursorEl.classList.remove('hidden');
    ringEl.classList.remove('hidden');
  }

  function hideAll() {
    cursorEl.classList.add('hidden');
    ringEl.classList.add('hidden');
    hintEl.classList.add('hidden');
    offscreenEl.classList.add('hidden');
    state.trail = [];
    state.move = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function showHint(text) {
    if (!text) {
      hintEl.classList.add('hidden');
      return;
    }
    hintEl.textContent = text;
    const x = Math.min(state.x + 20, window.innerWidth - 360);
    const y = Math.min(state.y + 22, window.innerHeight - 60);
    hintEl.style.left = Math.max(8, x) + 'px';
    hintEl.style.top = Math.max(8, y) + 'px';
    hintEl.classList.remove('hidden');
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(function () {
      hintEl.classList.add('hidden');
    }, HINT_LIFE_MS);
  }

  function pulse() {
    cursorEl.classList.remove('pulse');
    // Force a reflow so the animation restarts on repeated pulses.
    void cursorEl.offsetWidth;
    cursorEl.classList.add('pulse');
    ringEl.classList.remove('beat');
    void ringEl.offsetWidth;
    ringEl.classList.add('beat');
    clearTimeout(state.pulseTimer);
    state.pulseTimer = setTimeout(function () {
      cursorEl.classList.remove('pulse');
    }, 440);
  }

  function ripple() {
    const node = document.createElement('div');
    node.className = 'ripple';
    node.style.left = state.x + 'px';
    node.style.top = state.y + 'px';
    rippleLayer.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 800);
  }

  function showOffscreen(x, y, hint) {
    const margin = 54;
    const cx = Math.min(Math.max(x, margin), window.innerWidth - margin);
    const cy = Math.min(Math.max(y, margin), window.innerHeight - margin);
    offscreenEl.style.left = cx + 'px';
    offscreenEl.style.top = cy + 'px';
    const angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    offscreenArrow.style.transform = 'rotate(' + angle + 'deg)';
    offscreenText.textContent = hint;
    offscreenEl.classList.remove('hidden');
    clearTimeout(state.offscreenTimer);
    state.offscreenTimer = setTimeout(function () {
      offscreenEl.classList.add('hidden');
    }, HINT_LIFE_MS);
  }

  /** Move along a shallow arc so the motion reads as "the ghost is showing you". */
  function startMove(targetX, targetY, durationMs, hint) {
    const startX = state.x;
    const startY = state.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.hypot(dx, dy) || 1;
    const bend = Math.min(120, distance * 0.22);
    state.move = {
      startX: startX,
      startY: startY,
      midX: (startX + targetX) / 2 - (dy / distance) * bend,
      midY: (startY + targetY) / 2 + (dx / distance) * bend,
      targetX: targetX,
      targetY: targetY,
      startedAt: performance.now(),
      durationMs: Math.max(120, durationMs || 600),
    };
    showCursor();
    offscreenEl.classList.add('hidden');
    if (hint !== undefined) showHint(hint);
  }

  function drawTrail(now) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const trail = state.trail;
    while (trail.length > 0 && now - trail[0].at > TRAIL_LIFE_MS) trail.shift();
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i += 1) {
      const age = (now - trail[i].at) / TRAIL_LIFE_MS;
      const alpha = Math.max(0, 0.5 * (1 - age));
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.strokeStyle = 'rgba(140, 225, 255, ' + alpha.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, 3 * (1 - age));
      ctx.stroke();
    }
  }

  /** One loop drives movement and trail fading. */
  function frame(now) {
    const move = state.move;
    if (move) {
      const t = Math.min(1, (now - move.startedAt) / move.durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const inv = 1 - eased;
      const x =
        inv * inv * move.startX + 2 * inv * eased * move.midX + eased * eased * move.targetX;
      const y =
        inv * inv * move.startY + 2 * inv * eased * move.midY + eased * eased * move.targetY;
      placeCursor(x, y);
      state.trail.push({ x: x, y: y, at: now });
      if (state.trail.length > 160) state.trail.shift();
      if (t >= 1) {
        state.move = null;
        pulse();
      }
    }
    drawTrail(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function handleCommand(command) {
    if (!command || typeof command !== 'object') return;
    switch (command.kind) {
      case 'move':
        startMove(
          Number(command.x) || 0,
          Number(command.y) || 0,
          Number(command.durationMs) || 600,
          command.hint,
        );
        break;
      case 'pulse':
        showCursor();
        pulse();
        break;
      case 'ripple':
        ripple();
        break;
      case 'hint':
        showHint(String(command.text === undefined ? '' : command.text));
        break;
      case 'thinking':
        thinkingEl.classList.toggle('hidden', !command.on);
        break;
      case 'hide':
        hideAll();
        break;
      case 'offscreen':
        showOffscreen(
          Number(command.x) || 0,
          Number(command.y) || 0,
          String(command.hint === undefined ? '' : command.hint),
        );
        break;
      default:
        break;
    }
  }

  if (!window.ghost) {
    console.error('overlay renderer: preload API is missing');
    return;
  }
  window.ghost.onGhostCommand(handleCommand);
  // Answer every heartbeat so main knows the ghost is still drawable.
  window.ghost.onGhostHeartbeat(function () {
    window.ghost.ghostAck();
  });
  window.ghost.ghostReady();
  window.ghost.ghostAck();

})();
