/**
 * Shared type vocabulary for the Ghost Cursor prototype.
 *
 * Everything the planner is allowed to do lives in `ToolCall`. Nothing else can
 * reach the browser: the guardrail layer is the only door (see
 * src/main/agent/guardrails.ts).
 */

export type AgentState =
  | 'Idle'
  | 'Guiding'
  | 'AwaitingUser'
  | 'RunningCommand'
  | 'Halted';

/** Guide mode is the default; command mode only exists while a search command runs. */
export type Mode = 'guide' | 'command';

export type ToolName =
  | 'point_at'
  | 'click'
  | 'scroll'
  | 'type_in_search'
  | 'press_enter'
  | 'wait_for_user'
  | 'finish';

export type ScrollDirection = 'down' | 'up' | 'top' | 'bottom';

/** Events the injected page listener can report (spec section 7, step 5). */
export type WaitForEvent = 'focus' | 'click' | 'input' | 'navigation' | 'any';

export type ToolCall =
  | { tool: 'point_at'; args: { element_id: string; hint: string } }
  | { tool: 'click'; args: { element_id: string } }
  | { tool: 'scroll'; args: { direction: ScrollDirection; amount?: number; hint?: string } }
  | { tool: 'type_in_search'; args: { text: string } }
  | { tool: 'press_enter'; args: Record<string, never> }
  | { tool: 'wait_for_user'; args: { event: WaitForEvent; timeoutMs?: number; hint?: string } }
  | { tool: 'finish'; args: { message: string } };

export type ToolResult =
  | { ok: true; tool: ToolName; detail?: string }
  | { ok: false; tool: ToolName; reason: string };

/** Single-use typing permission. Created ONLY by the dialog layer. */
export type TypingGrant = {
  taskId: string;
  text: string; // exact title from the user's message
  field: 'search'; // page's main search input only
  usesLeft: 1 | 0; // consumed by the first type_in_search
  expiresAt: number; // task end or timeout, whichever comes first
  createdAt: number;
};

export type FieldRisk = 'none' | 'password' | 'payment' | 'personal';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One interactive element as seen by the planner (page CSS px, viewport relative). */
export interface SnapshotElement {
  id: string;
  tag: string;
  role: string;
  name: string;
  /** Viewport-relative box in page CSS px. */
  bbox: Box;
  inViewport: boolean;
  isSearchField: boolean;
  fieldRisk: FieldRisk;
  /** Risk of the enclosing <form>: blocks clicks inside password/payment forms. */
  formRisk?: FieldRisk;
  autocomplete?: string;
  /** Document order among peers with the same role, 1-based ("the second result"). */
  order: number;
  /** Short quoted excerpt, data only, never instructions. */
  textPreview?: string;
}


/** Screen geometry of the Chrome window, in Electron DIP (screen) coordinates. */
export interface BrowserGeometry {
  /** Outer window bounds in DIP screen coordinates. */
  bounds: Box;
  /** Viewport origin in DIP screen coordinates. */
  viewportLeft: number;
  viewportTop: number;
  /** Viewport size in DIP. */
  viewportWidth: number;
  viewportHeight: number;
  /** CSS px size of the viewport. */
  innerWidth: number;
  innerHeight: number;
  /** DIP per CSS px: page zoom. 1 when zoom is 100%. */
  scale: number;
  devicePixelRatio: number;
  /** Which method produced this mapping; used by calibration checks. */
  source: 'windowBounds' | 'screenXY';
  /** Cross-check delta between the two mapping methods, in DIP. */
  crossCheckDelta: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Commands the agent core may send to the ghost overlay (overlay only, never OS input). */
export type GhostCommand =
  | { kind: 'move'; x: number; y: number; durationMs: number; hint?: string }
  | { kind: 'pulse' }
  | { kind: 'ripple' }
  | { kind: 'hint'; text: string }
  | { kind: 'thinking'; on: boolean }
  | { kind: 'hide' }
  | { kind: 'offscreen'; x: number; y: number; hint: string };

export type StatusChip = 'Idle' | 'Guiding' | 'Running command' | 'Halted';

export interface DialogMessage {
  from: 'user' | 'ghost';
  text: string;
  at: number;
}

/** Page text handed to the planner is always wrapped as data, never as instructions. */
export interface SanitizedElement {
  id: string;
  role: string;
  name: string;
  order: number;
  inViewport: boolean;
  isSearchField: boolean;
  fieldRisk: FieldRisk;
  bbox: Box;
  textPreview?: string;
}

export interface SanitizedSnapshot {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewport: { width: number; height: number };
  searchFieldId: string | null;
  needsScreenshotFallback: boolean;
  elements: SanitizedElement[];
}

export interface PlanHistoryEntry {
  tool: ToolName;
  ok: boolean;
  detail?: string;
}

export interface PlanRequest {
  taskId: string;
  userMessage: string;
  state: AgentState;
  mode: Mode;
  allowedTools: ToolName[];
  snapshot: SanitizedSnapshot;
  history: PlanHistoryEntry[];
  denial: { tool: ToolName; reason: string } | null;
  hasTypingGrant: boolean;
  grantedTitle: string | null;
  /** True when the user explicitly asked for a click/scroll in guide mode. */
  userRequestedAction: boolean;
  attempt: number;
}

/** One interface for every planner implementation (hosted API, Ollama, heuristic). */
export interface Planner {
  readonly name: string;
  plan(request: PlanRequest): Promise<ToolCall>;
}

/** Intent classification performed by the planner (spec section 6). */
export type Intent = 'guidance' | 'action' | 'search_command';

export interface IntentResult {
  intent: Intent;
  /** Present only for an explicit search command; extracted by the dialog layer. */
  title: string | null;
  /** Which action the user asked for, when intent === 'action'. */
  action?: { type: 'click' | 'scroll'; direction?: ScrollDirection; target?: string };
  reason: string;
}

export interface LogRecord {
  at: string;
  level: 'info' | 'warn' | 'error';
  kind:
    | 'state'
    | 'tool_call'
    | 'tool_result'
    | 'denied'
    | 'grant'
    | 'heartbeat'
    | 'halt'
    | 'plan'
    | 'system';
  message: string;
  data?: Record<string, unknown>;
}

/** IPC channel names (single source of truth). */
export const IPC = {
  /** dialog renderer -> main */
  dialogSubmit: 'gc:dialog:submit',
  dialogHide: 'gc:dialog:hide',
  dialogEsc: 'gc:dialog:esc',
  dialogReady: 'gc:dialog:ready',
  /** main -> dialog renderer */
  dialogMessage: 'gc:dialog:message',
  dialogStatus: 'gc:dialog:status',
  dialogFocusInput: 'gc:dialog:focus-input',
  /** main -> overlay renderer */
  ghostCommand: 'gc:ghost:command',
  ghostHeartbeat: 'gc:ghost:heartbeat',
  ghostReady: 'gc:ghost:ready',
  /** overlay renderer -> main */
  ghostHeartbeatAck: 'gc:ghost:heartbeat-ack',
} as const;

export const TELEGRAPH_PAUSE_MS = 400;
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 1_000;
export const HEARTBEAT_TIMEOUT_MS = 2_500;
export const MAX_FAILED_ATTEMPTS = 3;
export const GRANT_TTL_MS = 120_000;
export const DOUBLE_ESC_WINDOW_MS = 800;
/** Below this many elements the snapshot is considered poor (canvas players). */
export const ELEMENT_POVERTY_THRESHOLD = 4;


export interface PageSnapshot {
  snapshotId: string;
  url: string;
  title: string;
  scroll: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  elements: SnapshotElement[];
  searchFieldId: string | null;
  /** The search box is the only field whose value a snapshot may carry. */
  searchFieldValue?: string;
  /** True when the page exposes too few elements (canvas players etc). */
  needsScreenshotFallback: boolean;
}
