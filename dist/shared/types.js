"use strict";
/**
 * Shared type vocabulary for the Ghost Cursor prototype.
 *
 * Everything the planner is allowed to do lives in `ToolCall`. Nothing else can
 * reach the browser: the guardrail layer is the only door (see
 * src/main/agent/guardrails.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ELEMENT_POVERTY_THRESHOLD = exports.DOUBLE_ESC_WINDOW_MS = exports.GRANT_TTL_MS = exports.MAX_FAILED_ATTEMPTS = exports.HEARTBEAT_TIMEOUT_MS = exports.HEARTBEAT_INTERVAL_MS = exports.DEFAULT_WAIT_TIMEOUT_MS = exports.TELEGRAPH_PAUSE_MS = exports.IPC = void 0;
/** IPC channel names (single source of truth). */
exports.IPC = {
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
};
exports.TELEGRAPH_PAUSE_MS = 400;
exports.DEFAULT_WAIT_TIMEOUT_MS = 60_000;
exports.HEARTBEAT_INTERVAL_MS = 1_000;
exports.HEARTBEAT_TIMEOUT_MS = 2_500;
exports.MAX_FAILED_ATTEMPTS = 3;
exports.GRANT_TTL_MS = 120_000;
exports.DOUBLE_ESC_WINDOW_MS = 800;
/** Below this many elements the snapshot is considered poor (canvas players). */
exports.ELEMENT_POVERTY_THRESHOLD = 4;
//# sourceMappingURL=types.js.map