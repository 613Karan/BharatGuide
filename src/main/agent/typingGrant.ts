import { GRANT_TTL_MS } from '../../shared/types';
import type { TypingGrant } from '../../shared/types';

export type GrantDecision = { ok: true } | { ok: false; reason: string };

export interface GrantStoreEvents {
  onCreated?: (grant: TypingGrant) => void;
  onConsumed?: (grant: TypingGrant) => void;
  onDropped?: (reason: string, grant: TypingGrant | null) => void;
}

/**
 * Holds at most one TypingGrant.
 *
 * The grant is created ONLY by the dialog layer, when the user's message is an
 * explicit search command (spec section 2, rule 4). The planner can never create
 * one: `create` is the only way in and the agent core never calls it.
 */
export class GrantStore {
  private grant: TypingGrant | null = null;
  private readonly events: GrantStoreEvents;

  constructor(events: GrantStoreEvents = {}) {
    this.events = events;
  }

  get current(): TypingGrant | null {
    return this.grant;
  }

  get hasGrant(): boolean {
    return this.grant !== null;
  }

  /** Dialog layer only. Replaces any stale grant. */
  create(taskId: string, text: string, now: number = Date.now()): TypingGrant {
    const grant: TypingGrant = {
      taskId,
      text,
      field: 'search',
      usesLeft: 1,
      expiresAt: now + GRANT_TTL_MS,
      createdAt: now,
    };
    this.grant = grant;
    this.events.onCreated?.(grant);
    return grant;
  }

  isUsable(now: number = Date.now()): GrantDecision {
    const grant = this.grant;
    if (!grant) return { ok: false, reason: 'no typing grant exists' };
    if (grant.usesLeft < 1) return { ok: false, reason: 'typing grant was already used' };
    if (now >= grant.expiresAt) {
      this.drop('expired', now);
      return { ok: false, reason: 'typing grant expired' };
    }
    return { ok: true };
  }

  /** Consumed by the first successful type_in_search. Single use, always. */
  consume(now: number = Date.now()): GrantDecision {
    const usable = this.isUsable(now);
    if (!usable.ok) return usable;
    const grant = this.grant!;
    this.grant = { ...grant, usesLeft: 0 };
    this.events.onConsumed?.(this.grant);
    return { ok: true };
  }

  /** Task end, halt, or timeout: the grant disappears. */
  drop(reason: string, now: number = Date.now()): void {
    const grant = this.grant;
    this.grant = null;
    void now;
    this.events.onDropped?.(reason, grant);
  }

  /** True when `text` is exactly the granted title (spec section 8 guard). */
  matchesGrantedText(text: string): GrantDecision {
    const grant = this.grant;
    if (!grant) return { ok: false, reason: 'no typing grant exists' };
    if (text !== grant.text) {
      return {
        ok: false,
        reason: `text differs from the granted title (granted ${JSON.stringify(grant.text)})`,
      };
    }
    return { ok: true };
  }
}
