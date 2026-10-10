import { DEFAULT_WAIT_TIMEOUT_MS, ELEMENT_POVERTY_THRESHOLD } from '../../shared/types';
import type {
  AgentState,
  Mode,
  PageSnapshot,
  SnapshotElement,
  ToolCall,
  ToolName,
  TypingGrant,
} from '../../shared/types';

/**
 * Guardrails (spec section 10).
 *
 * These checks run in code, not in the prompt. Whatever the model says, a call
 * the current state does not allow is rejected and the reason goes back to the
 * planner. Rejected calls are never executed.
 */

export interface GuardContext {
  state: AgentState;
  mode: Mode;
  grant: TypingGrant | null;
  /** True when the user explicitly asked for a click/scroll during this task. */
  userRequestedAction: boolean;
  /** Last tool call that executed successfully (press_enter ordering guard). */
  lastSuccessfulTool: ToolName | null;
  snapshot: PageSnapshot | null;
  now: number;
}

export type GuardDecision =
  | { ok: true; call: ToolCall; notes: string[] }
  | { ok: false; reason: string };

export const ALL_TOOLS: readonly ToolName[] = [
  'point_at',
  'click',
  'scroll',
  'type_in_search',
  'press_enter',
  'wait_for_user',
  'finish',
];

export function findElement(
  snapshot: PageSnapshot | null,
  elementId: string,
): SnapshotElement | null {
  if (!snapshot) return null;
  return snapshot.elements.find((element) => element.id === elementId) ?? null;
}

/** Password, payment and personal-data fields are never typed into or clicked. */
export function isSensitiveField(element: SnapshotElement | null): boolean {
  if (!element) return false;
  return element.fieldRisk !== 'none' || (element.formRisk ?? 'none') !== 'none';
}

/**
 * What the planner may call right now. The list is derived from the state
 * machine and the grant, never from the model's own claims.
 */
export function allowedTools(context: GuardContext): ToolName[] {
  if (context.state === 'Halted') return [];

  const tools: ToolName[] = ['point_at', 'wait_for_user', 'finish'];
  const mayAct = context.state === 'RunningCommand' || context.userRequestedAction;
  if (mayAct) {
    tools.push('click', 'scroll');
  }
  if (context.state === 'RunningCommand') {
    if (grantIsUsable(context.grant, context.now).ok) tools.push('type_in_search');
    if (context.lastSuccessfulTool === 'type_in_search') tools.push('press_enter');
  }
  return tools;
}

export function grantIsUsable(
  grant: TypingGrant | null,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!grant) return { ok: false, reason: 'no typing grant exists' };
  if (grant.usesLeft < 1) return { ok: false, reason: 'the typing grant was already used' };
  if (now >= grant.expiresAt) return { ok: false, reason: 'the typing grant expired' };
  return { ok: true };
}

const MAX_SCROLL_INPUT_MS = 10_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 120_000;

/** Clamp inputs so a call can never exceed its documented limit. */
export function normalizeToolCall(call: ToolCall, context: GuardContext): ToolCall {
  if (call.tool === 'scroll') {
    const viewportHeight = context.snapshot?.viewport.height ?? 800;
    const amount = call.args.amount;
    if (typeof amount === 'number') {
      const clamped = Math.max(1, Math.min(Math.round(amount), viewportHeight));
      if (clamped !== amount) return { tool: 'scroll', args: { ...call.args, amount: clamped } };
    }
    return call;
  }
  if (call.tool === 'wait_for_user') {
    const timeout = call.args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const clamped = Math.max(MIN_WAIT_MS, Math.min(timeout, MAX_WAIT_MS));
    if (clamped !== timeout) {
      return { tool: 'wait_for_user', args: { ...call.args, timeoutMs: clamped } };
    }
    return call;
  }
  return call;
}

/**
 * The single validation door. Returns either an approved (possibly normalized)
 * call plus notes, or a refusal reason that goes back to the planner.
 */
export function validateToolCall(rawCall: ToolCall, context: GuardContext): GuardDecision {
  const call = normalizeToolCall(rawCall, context);
  const notes: string[] = [];

  if (context.state === 'Halted') {
    return { ok: false, reason: 'the agent is halted: no tool call may run' };
  }
  if (!ALL_TOOLS.includes(call.tool)) {
    return { ok: false, reason: `unknown tool "${String(call.tool)}"` };
  }

  switch (call.tool) {
    case 'point_at': {
      const element = findElement(context.snapshot, call.args.element_id);
      if (!element) {
        return { ok: false, reason: `unknown element id "${call.args.element_id}"` };
      }
      if (!element.inViewport) {
        notes.push('element is off screen: point toward it and hint that scrolling is needed');
      }
      return { ok: true, call, notes };
    }

    case 'click': {
      if (context.state === 'Idle') {
        return { ok: false, reason: 'click is not allowed while Idle' };
      }
      if (context.state !== 'RunningCommand' && !context.userRequestedAction) {
        return {
          ok: false,
          reason:
            'click is not allowed in guide mode unless the user asked for it ("click it")',
        };
      }
      const element = findElement(context.snapshot, call.args.element_id);
      if (!element) {
        return { ok: false, reason: `unknown element id "${call.args.element_id}"` };
      }
      if (element.fieldRisk !== 'none') {
        return { ok: false, reason: `refusing to click a ${element.fieldRisk} field` };
      }
      if ((element.formRisk ?? 'none') !== 'none') {
        return {
          ok: false,
          reason: `refusing to click inside a form that contains ${element.formRisk} fields`,
        };
      }
      if (context.snapshot?.needsScreenshotFallback) {
        return {
          ok: false,
          reason:
            'page exposes too few elements (screenshot fallback): the ghost points but does not click',
        };
      }
      if (!element.inViewport) {
        notes.push('element is off screen: it is scrolled into view before the click');
      }
      notes.push('400 ms telegraph before dispatch');
      return { ok: true, call, notes };
    }

    case 'scroll': {
      if (context.state !== 'RunningCommand' && !context.userRequestedAction) {
        return {
          ok: false,
          reason:
            'scroll is not allowed in guide mode unless the user asked for it ("scroll down")',
        };
      }
      const directions = ['down', 'up', 'top', 'bottom'];
      if (!directions.includes(call.args.direction)) {
        return { ok: false, reason: `unknown scroll direction "${call.args.direction}"` };
      }
      if (typeof call.args.amount === 'number' && call.args.amount <= 0) {
        return { ok: false, reason: 'scroll amount must be positive' };
      }
      notes.push('scroll is limited to at most one screen height per call');
      return { ok: true, call, notes };
    }

    case 'type_in_search': {
      if (context.state !== 'RunningCommand') {
        return {
          ok: false,
          reason: `type_in_search is only allowed in RunningCommand (current state: ${context.state})`,
        };
      }
      const usable = grantIsUsable(context.grant, context.now);
      if (!usable.ok) return { ok: false, reason: usable.reason };
      const grant = context.grant!;
      if (call.args.text !== grant.text) {
        return {
          ok: false,
          reason:
            'text differs from the granted title: only the exact title from the user message may be typed',
        };
      }
      const snapshot = context.snapshot;
      if (!snapshot) return { ok: false, reason: 'no snapshot: cannot locate the search field' };
      if (!snapshot.searchFieldId) {
        return { ok: false, reason: 'this page has no main search field' };
      }
      const field = findElement(snapshot, snapshot.searchFieldId);
      if (field && field.fieldRisk !== 'none') {
        return { ok: false, reason: `refusing to type into a ${field.fieldRisk} field` };
      }
      if (field && (field.formRisk ?? 'none') !== 'none') {
        return {
          ok: false,
          reason: `refusing to type into a field inside a form with ${field.formRisk} fields`,
        };
      }
      notes.push('single-use grant consumed by this call');
      return { ok: true, call, notes };
    }

    case 'press_enter': {
      if (context.state !== 'RunningCommand') {
        return {
          ok: false,
          reason: `press_enter is only allowed in RunningCommand (current state: ${context.state})`,
        };
      }
      if (context.lastSuccessfulTool !== 'type_in_search') {
        return {
          ok: false,
          reason: 'press_enter is only allowed immediately after a granted type_in_search',
        };
      }
      return { ok: true, call, notes };
    }

    case 'wait_for_user': {
      const events = ['focus', 'click', 'input', 'navigation', 'any'];
      if (!events.includes(call.args.event)) {
        return { ok: false, reason: `unknown wait event "${call.args.event}"` };
      }
      return { ok: true, call, notes };
    }

    case 'finish': {
      return { ok: true, call, notes };
    }
  }

  return { ok: false, reason: 'unreachable: tool call was not handled' };
}

/** True when a snapshot is too poor to act on (canvas players and the like). */
export function snapshotIsPoor(snapshot: PageSnapshot | null): boolean {
  if (!snapshot) return true;
  return snapshot.elements.length < ELEMENT_POVERTY_THRESHOLD;
}

