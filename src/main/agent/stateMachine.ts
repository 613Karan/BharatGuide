import type { AgentState } from '../../shared/types';

/** Triggers of the spec section 9 transition table. */
export type StateTrigger =
  | 'user_message'
  | 'ghost_pointed'
  | 'user_acted'
  | 'finish_or_timeout'
  | 'search_command'
  | 'results_shown'
  | 'halt'
  | 'resume';

interface TransitionRule {
  from: AgentState[];
  to: AgentState;
  trigger: StateTrigger;
}

/** Spec section 9, verbatim. Anything not listed here is impossible. */
const TRANSITIONS: readonly TransitionRule[] = [
  { from: ['Idle'], to: 'Guiding', trigger: 'user_message' },
  { from: ['Guiding'], to: 'AwaitingUser', trigger: 'ghost_pointed' },
  { from: ['AwaitingUser'], to: 'Guiding', trigger: 'user_acted' },
  { from: ['AwaitingUser'], to: 'Idle', trigger: 'finish_or_timeout' },
  { from: ['Guiding'], to: 'Idle', trigger: 'finish_or_timeout' },
  { from: ['Idle', 'Guiding'], to: 'RunningCommand', trigger: 'search_command' },
  { from: ['RunningCommand'], to: 'Guiding', trigger: 'results_shown' },
  {
    from: ['Idle', 'Guiding', 'AwaitingUser', 'RunningCommand'],
    to: 'Halted',
    trigger: 'halt',
  },
  { from: ['Halted'], to: 'Idle', trigger: 'resume' },
];

export interface TransitionResult {
  ok: boolean;
  from: AgentState;
  to: AgentState;
  trigger: StateTrigger;
  reason?: string;
}

export type StateListener = (from: AgentState, to: AgentState, trigger: StateTrigger) => void;

export class StateMachine {
  private current: AgentState = 'Idle';
  private readonly listeners: StateListener[] = [];

  get state(): AgentState {
    return this.current;
  }

  /** Guide mode is the default; command mode exists only in RunningCommand. */
  get mode(): 'guide' | 'command' {
    return this.current === 'RunningCommand' ? 'command' : 'guide';
  }

  /** Only RunningCommand may type or press Enter (spec section 9). */
  get typingAllowed(): boolean {
    return this.current === 'RunningCommand';
  }

  onChange(listener: StateListener): void {
    this.listeners.push(listener);
  }

  /** Next state for a trigger, or null when the trigger is not allowed now. */
  nextState(trigger: StateTrigger): AgentState | null {
    const rule = TRANSITIONS.find(
      (candidate) => candidate.trigger === trigger && candidate.from.includes(this.current),
    );
    return rule ? rule.to : null;
  }

  can(trigger: StateTrigger): boolean {
    return this.nextState(trigger) !== null;
  }

  /** Apply a trigger. Illegal triggers are refused, never applied. */
  apply(trigger: StateTrigger): TransitionResult {
    const from = this.current;
    const to = this.nextState(trigger);
    if (!to) {
      return {
        ok: false,
        from,
        to: from,
        trigger,
        reason: `transition ${trigger} is not allowed from ${from}`,
      };
    }
    this.current = to;
    for (const listener of this.listeners) listener(from, to, trigger);
    return { ok: true, from, to, trigger };
  }

  /** Esc twice, or the overlay being lost: halt from any state. */
  halt(): TransitionResult {
    if (this.current === 'Halted') {
      return { ok: true, from: 'Halted', to: 'Halted', trigger: 'halt' };
    }
    return this.apply('halt');
  }

  /** Test helper: put the machine in a specific state using legal transitions. */
  reset(state: AgentState = 'Idle'): void {
    this.current = state;
  }

  static allowedTriggers(state: AgentState): StateTrigger[] {
    return TRANSITIONS.filter((rule) => rule.from.includes(state)).map((rule) => rule.trigger);
  }

  static get rules(): readonly TransitionRule[] {
    return TRANSITIONS;
  }
}
