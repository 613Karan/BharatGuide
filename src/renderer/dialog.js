/**
 * Dialog renderer: the user's control surface.
 *
 * Sending text goes to main over IPC only - this window never talks to Chrome
 * and never moves the mouse. Esc always reaches main so it can stop the ghost.
 */
(function () {
  'use strict';

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const statusEl = document.getElementById('status');
  const hintEl = document.getElementById('hint');
  const closeBtn = document.getElementById('closeBtn');

  const MAX_MESSAGES = 200;
  const DEFAULT_HINT =
    'Enter sends · Esc stops the ghost · double Esc halts automation · your mouse stays yours';

  const STATE_HINTS = {
    Idle: 'Say what to do, or ask how to do it. Questions stay guidance.',
    Perceiving: 'Looking at the page…',
    Planning: 'Choosing the next step…',
    Telegraphing: 'The ghost is showing you where it will go…',
    Acting: 'The ghost is acting in Chrome. Esc stops it.',
    Verifying: 'Checking that the step really happened…',
    Finishing: 'Wrapping up…',
    WaitingForUser: 'Waiting for you. Click or type yourself - the ghost only points.',
    AwaitingUser: 'Waiting for you. Click or type yourself - the ghost only points.',
    Halted: 'Automation halted. Type "resume" when you are ready.',
    Faulted: 'The ghost stopped after repeated failures. You still have full control.',
    Shutdown: 'Shutting down.',
  };

  function appendMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    const role = ['user', 'assistant', 'system', 'error'].indexOf(payload.role) >= 0
      ? payload.role
      : 'system';
    const text = String(payload.text === undefined ? '' : payload.text);
    if (!text) return;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = text;
    messagesEl.appendChild(node);
    while (messagesEl.childElementCount > MAX_MESSAGES) {
      messagesEl.removeChild(messagesEl.firstElementChild);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(payload) {
    const state = payload && payload.state ? String(payload.state) : 'Idle';
    statusEl.textContent = state;
    statusEl.setAttribute('data-state', state);
    const hint = payload && payload.hint ? String(payload.hint) : STATE_HINTS[state];
    hintEl.textContent = hint || DEFAULT_HINT;
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    window.ghost.dialogSubmit(text);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submit();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      window.ghost.dialogEsc();
      return;
    }
    // Same hotkey as the global shortcut, for when the panel has focus.
    if (event.ctrlKey && event.shiftKey && (event.key === 'G' || event.key === 'g')) {
      event.preventDefault();
      window.ghost.dialogHide();
    }
  });

  closeBtn.addEventListener('click', function () {
    window.ghost.dialogHide();
  });

  if (!window.ghost) {
    console.error('dialog renderer: preload API is missing');
    return;
  }

  window.ghost.onDialogMessage(appendMessage);
  window.ghost.onDialogStatus(setStatus);
  window.ghost.onDialogFocusInput(function () {
    input.focus();
    input.select();
  });
  window.ghost.onGhostHeartbeat(function () {
    window.ghost.dialogAck();
  });

  window.ghost.dialogReady();
  window.ghost.dialogAck();
  setStatus({ state: 'Idle' });
  appendMessage({
    role: 'system',
    text: 'Ghost Cursor ready. The ghost points and narrates; you keep the mouse.',
  });
  input.focus();
})();
