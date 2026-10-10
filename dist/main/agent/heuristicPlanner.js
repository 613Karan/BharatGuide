"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeuristicPlanner = void 0;
const types_1 = require("../../shared/types");
/**
 * Heuristic planner (spec section 5, step 2).
 *
 * Deterministic and offline. It follows the tool table for the current mode and
 * proposes exactly one call per step. It is both the default planner and the
 * safety net when Ollama is not running, so the demo never depends on a model.
 *
 * Nothing here can act on its own: guardrails.ts validates every proposal and is
 * the only door to a real action.
 */
class HeuristicPlanner {
    name = 'heuristic';
    async plan(request) {
        const allowed = new Set(request.allowedTools);
        return request.mode === 'command' ? this.command(request, allowed) : this.guide(request, allowed);
    }
    /**
     * Command mode: the user asked for a search. Point -> type the granted title ->
     * Enter -> let the user read the results. Only the granted title is ever typed.
     */
    command(request, allowed) {
        const snapshot = request.snapshot;
        const searchField = findById(snapshot, snapshot.searchFieldId);
        if (!searchField) {
            if (allowed.has('point_at') && !pointedAlready(request)) {
                const candidate = bestTextMatch(snapshot.elements, request.userMessage) ?? null;
                if (candidate)
                    return this.pointAt(candidate, 'Nearest match for your words');
            }
            if (allowed.has('wait_for_user')) {
                return this.wait('This page has no search field yet. Waiting for you.');
            }
            return this.finish('This page has no search field, so nothing was typed or submitted.');
        }
        if (allowed.has('type_in_search')) {
            if (!request.hasTypingGrant || !request.grantedTitle) {
                return this.finish('I have no typing permission for this task, so nothing was typed.');
            }
            if (!searchField.inViewport && allowed.has('scroll')) {
                return this.scroll('down', 'The search field is off screen, scrolling to it.');
            }
            return { tool: 'type_in_search', args: { text: request.grantedTitle } };
        }
        // Guardrails only offer press_enter immediately after a successful type.
        if (allowed.has('press_enter'))
            return { tool: 'press_enter', args: {} };
        if (allowed.has('point_at') && !pointedAlready(request)) {
            return this.pointAt(searchField, 'Search field');
        }
        if (allowed.has('wait_for_user'))
            return this.wait('Results are on the page. Your turn.');
        return this.finish('Done: the search ran and the results are on the page.');
    }
    /**
     * Guide mode: show, never click. A click or a scroll happens only when the user
     * explicitly asked for that action.
     */
    guide(request, allowed) {
        const snapshot = request.snapshot;
        if (snapshot.elements.length === 0) {
            if (allowed.has('wait_for_user'))
                return this.wait('I cannot see anything on the page yet.');
            return this.finish('There is nothing actionable on this page.');
        }
        if (allowed.has('click') && request.userRequestedAction) {
            const target = bestTextMatch(snapshot.elements, request.userMessage) ?? firstVisible(snapshot);
            if (target)
                return { tool: 'click', args: { element_id: target.id } };
        }
        // Point once per task. Repeating the same point would only re-animate the ghost
        // while the user is already looking at the target, so hand control back instead.
        if (allowed.has('point_at') && !pointedAlready(request)) {
            const target = bestTextMatch(snapshot.elements, request.userMessage) ?? firstVisible(snapshot);
            if (target)
                return this.pointAt(target, hintFor(target));
        }
        if (allowed.has('scroll') && wantsScroll(request.userMessage)) {
            const direction = scrollDirection(request.userMessage, snapshot);
            if (direction)
                return this.scroll(direction, 'Scrolling the page for you.');
        }
        if (allowed.has('wait_for_user')) {
            return this.wait('Your turn: the real mouse and keyboard stay yours.');
        }
        return this.finish('Nothing left to show on this page.');
    }
    pointAt(element, hint) {
        return { tool: 'point_at', args: { element_id: element.id, hint } };
    }
    scroll(direction, hint) {
        return { tool: 'scroll', args: { direction, hint } };
    }
    wait(hint) {
        return {
            tool: 'wait_for_user',
            args: { event: 'any', timeoutMs: types_1.DEFAULT_WAIT_TIMEOUT_MS, hint },
        };
    }
    finish(message) {
        return { tool: 'finish', args: { message } };
    }
}
exports.HeuristicPlanner = HeuristicPlanner;
/** True when this task already pointed successfully, so the ghost need not repeat. */
function pointedAlready(request) {
    return request.history.some((entry) => entry.tool === 'point_at' && entry.ok);
}
function findById(snapshot, id) {
    if (!id)
        return null;
    return snapshot.elements.find((element) => element.id === id) ?? null;
}
/**
 * Score elements by how much of the user's message they contain. Names arrive
 * quoted from sanitize.ts, which does not change a substring match.
 */
function bestTextMatch(elements, message) {
    const words = message.toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? [];
    if (words.length === 0)
        return null;
    let best = null;
    let bestScore = 0;
    for (const element of elements) {
        const haystack = `${element.role} ${element.name} ${element.textPreview ?? ''}`.toLowerCase();
        let score = 0;
        for (const word of words)
            if (haystack.includes(word))
                score += 1;
        if (score === 0)
            continue;
        if (element.inViewport)
            score += 0.5;
        if (score > bestScore) {
            bestScore = score;
            best = element;
        }
    }
    return bestScore >= 1 ? best : null;
}
function firstVisible(snapshot) {
    return snapshot.elements.find((element) => element.inViewport) ?? snapshot.elements[0] ?? null;
}
/** Short human-readable label for the overlay hint bubble. */
function hintFor(element) {
    const label = element.name.length > 2 ? element.name : element.role;
    return label.length > 60 ? `${label.slice(0, 60)}...` : label;
}
function wantsScroll(message) {
    return /\b(scroll|scrollen|runter|nach unten|nach oben|weiter|down|up|top|bottom|weiterlesen)\b/i.test(message);
}
function scrollDirection(message, snapshot) {
    const text = message.toLowerCase();
    const canScrollDown = snapshot.scrollY + snapshot.viewport.height < snapshot.scrollHeight - 8;
    const canScrollUp = snapshot.scrollY > 8;
    if (/(\btop\b|anfang|ganz nach oben|to the top|\bup\b|nach oben|hoch)/.test(text)) {
        return canScrollUp ? 'up' : null;
    }
    if (/(\bbottom\b|ende|ganz nach unten)/.test(text))
        return canScrollDown ? 'bottom' : null;
    return canScrollDown ? 'down' : null;
}
//# sourceMappingURL=heuristicPlanner.js.map