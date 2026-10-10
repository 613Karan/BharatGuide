"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GrantStore = void 0;
const types_1 = require("../../shared/types");
/**
 * Holds at most one TypingGrant.
 *
 * The grant is created ONLY by the dialog layer, when the user's message is an
 * explicit search command (spec section 2, rule 4). The planner can never create
 * one: `create` is the only way in and the agent core never calls it.
 */
class GrantStore {
    grant = null;
    events;
    constructor(events = {}) {
        this.events = events;
    }
    get current() {
        return this.grant;
    }
    get hasGrant() {
        return this.grant !== null;
    }
    /** Dialog layer only. Replaces any stale grant. */
    create(taskId, text, now = Date.now()) {
        const grant = {
            taskId,
            text,
            field: 'search',
            usesLeft: 1,
            expiresAt: now + types_1.GRANT_TTL_MS,
            createdAt: now,
        };
        this.grant = grant;
        this.events.onCreated?.(grant);
        return grant;
    }
    isUsable(now = Date.now()) {
        const grant = this.grant;
        if (!grant)
            return { ok: false, reason: 'no typing grant exists' };
        if (grant.usesLeft < 1)
            return { ok: false, reason: 'typing grant was already used' };
        if (now >= grant.expiresAt) {
            this.drop('expired', now);
            return { ok: false, reason: 'typing grant expired' };
        }
        return { ok: true };
    }
    /** Consumed by the first successful type_in_search. Single use, always. */
    consume(now = Date.now()) {
        const usable = this.isUsable(now);
        if (!usable.ok)
            return usable;
        const grant = this.grant;
        this.grant = { ...grant, usesLeft: 0 };
        this.events.onConsumed?.(this.grant);
        return { ok: true };
    }
    /** Task end, halt, or timeout: the grant disappears. */
    drop(reason, now = Date.now()) {
        const grant = this.grant;
        this.grant = null;
        void now;
        this.events.onDropped?.(reason, grant);
    }
    /** True when `text` is exactly the granted title (spec section 8 guard). */
    matchesGrantedText(text) {
        const grant = this.grant;
        if (!grant)
            return { ok: false, reason: 'no typing grant exists' };
        if (text !== grant.text) {
            return {
                ok: false,
                reason: `text differs from the granted title (granted ${JSON.stringify(grant.text)})`,
            };
        }
        return { ok: true };
    }
}
exports.GrantStore = GrantStore;
//# sourceMappingURL=typingGrant.js.map