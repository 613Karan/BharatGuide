/**
 * Typed IPC contract (spec 7.3). The single source of truth for every message
 * that crosses a process boundary.
 *
 * - Chat renderer: sends ChatCommand, receives ChatEvent.
 * - Toolbar renderer: sends ToolbarCommand, receives ToolbarState / ToolbarFx.
 * - Overlay renderer: receives OverlayCommand only (plus heartbeat).
 * None of them can reach the network, the tab manager, or the agent directly.
 */

export type AgentState = 'Idle' | 'Guiding' | 'AwaitingUser' | 'RunningCommand' | 'Halted';

export type Citation = {
  org: string;
  doc_title: string;
  section_path: string;
  pages: number[];
  publication_date: string;
  source_url: string;
};

export type CardKind = 'abstain' | 'service_down' | 'halted' | 'redaction';

export type ChatEvent =
  | { t: 'user_msg'; id: string; text: string; redacted: boolean }
  | { t: 'assistant_start'; id: string }
  | { t: 'assistant_delta'; id: string; text: string }
  | { t: 'assistant_end'; id: string; sources?: Citation[] } // sources present => fact bubble
  | { t: 'status'; text: string | null } // the subtitle
  | { t: 'state'; state: AgentState }
  | { t: 'card'; kind: CardKind; body: string; helpline?: string }
  | { t: 'last_verified'; date: string }
  | { t: 'service'; status: 'ok' | 'warming_up' | 'down' };

export type ChatCommand =
  | { t: 'send'; text: string }
  | { t: 'kill' }
  | { t: 'esc' }
  | { t: 'collapse'; collapsed: boolean }
  | { t: 'open_source'; url: string };

export type OverlayCommand =
  | { t: 'move'; x: number; y: number; ms: number }
  | { t: 'pulse'; x: number; y: number }
  | { t: 'ripple'; x: number; y: number }
  | { t: 'hint'; text: string; x: number; y: number }
  | { t: 'hide' };

export type TabInfo = { id: string; title: string; url: string; loading: boolean };

export type ToolbarState = {
  tabs: TabInfo[];
  activeId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
};

/** Visual-only effects on the toolbar (never keystrokes): spec 6.4. */
export type ToolbarFx = { t: 'animate_url'; url: string; ms: number };

export type ToolbarCommand =
  | { t: 'switch'; id: string }
  | { t: 'close'; id: string }
  | { t: 'new_tab' }
  | { t: 'navigate'; url: string }
  | { t: 'back' }
  | { t: 'forward' }
  | { t: 'reload' }
  | { t: 'esc' };

/** A toolbar element rect as reported by the toolbar renderer (CSS px == DIP). */
export type GhostRect = { id: string; x: number; y: number; width: number; height: number };

export const IPC = {
  chatCommand: 'chat:command',
  chatEvent: 'chat:event',
  chatReady: 'chat:ready',
  chatFocusInput: 'chat:focus-input',
  toolbarCommand: 'toolbar:command',
  toolbarState: 'toolbar:state',
  toolbarFx: 'toolbar:fx',
  toolbarRects: 'toolbar:rects',
  toolbarReady: 'toolbar:ready',
  overlayCommand: 'overlay:command',
  overlayPing: 'overlay:ping',
  overlayPong: 'overlay:pong',
} as const;
