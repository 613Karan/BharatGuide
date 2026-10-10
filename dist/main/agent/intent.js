"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.intentName = void 0;
exports.extractTitle = extractTitle;
exports.isExplicitSearchCommand = isExplicitSearchCommand;
exports.classifyIntent = classifyIntent;
exports.userRequestedAction = userRequestedAction;
exports.grantEcho = grantEcho;
/**
 * Dialog-layer intent extraction.
 *
 * This module is the ONLY place a TypingGrant can originate (spec section 2,
 * rule 4). It is deliberately conservative: anything ambiguous becomes a
 * guidance request, never a search command.
 */
/** Verbs that can introduce an explicit search command. */
const SEARCH_VERB = /^(?:please\s+|could\s+you\s+|can\s+you\s+|go\s+ahead\s+and\s+)*(?:search|find|look\s+for|look\s+up|google)\b/i;
/** "search for X" / "find X": the title is everything after the verb. */
const SEARCH_COMMAND_PATTERNS = [
    /^\s*(?:please\s+|could\s+you\s+|can\s+you\s+|go\s+ahead\s+and\s+)*(?:search|google)\s+(?:for|up)\s+(.+?)\s*[.!?]*\s*$/i,
    /^\s*(?:please\s+|could\s+you\s+|can\s+you\s+|go\s+ahead\s+and\s+)*(?:look)\s+(?:for|up)\s+(.+?)\s*[.!?]*\s*$/i,
    /^\s*(?:please\s+|could\s+you\s+|can\s+you\s+|go\s+ahead\s+and\s+)*search\s+(.+?)\s*[.!?]*\s*$/i,
    /^\s*(?:please\s+|could\s+you\s+|can\s+you\s+|go\s+ahead\s+and\s+)*find\s+(.+?)\s*[.!?]*\s*$/i,
];
/** A quoted title anywhere in the message, e.g. `search "Bohemian Rhapsody"`. */
const QUOTED_TITLE = /["“”‘’'`]([^"“”‘’'`]{2,200})["“”‘’'`]/;
/** Questions are guidance, never commands. */
const QUESTION_START = /^\s*(?:how|what|where|why|when|which|who|can|could|should|would|is|are|am|do|does|did|will|shall|may|might|tell\s+me\s+how)\b/i;
/**
 * Words that mean the user is talking about the UI, not giving a title.
 * "find the videos tab" must not create a grant.
 */
const UI_REFERENCE = /\b(?:tab|tabs|button|buttons|link|links|icon|menu|search\s+(?:bar|box|field|input)|address\s+bar|url\s+bar|result|results|second|third|first|page|screen|it|that|this|them|something|anything|nothing|stuff|things)\b/i;
const ACTION_CLICK = /^\s*(?:please\s+)*(?:click|tap|press|hit|open|select|choose)\b/i;
const ACTION_SCROLL = /^\s*(?:please\s+)*(?:scroll|page\s+down|page\s+up|move\s+down|move\s+up)\b/i;
/** Trim trailing punctuation and filler from an extracted title. */
function cleanTitle(raw) {
    return raw
        .trim()
        .replace(/[.!?]+$/g, '')
        .replace(/\s+(?:for\s+me|please|now)$/i, '')
        .trim();
}
/**
 * Extract the title of an explicit search command.
 * Returns null when the message is not an explicit search command.
 */
function extractTitle(message) {
    const text = message.trim();
    if (!text)
        return null;
    // Questions are guidance requests, never search commands.
    if (QUESTION_START.test(text) || text.endsWith('?'))
        return null;
    const quoted = QUOTED_TITLE.exec(text);
    if (quoted && SEARCH_VERB.test(text)) {
        const title = cleanTitle(quoted[1]);
        return title.length >= 2 && !UI_REFERENCE.test(title) ? title : null;
    }
    for (const pattern of SEARCH_COMMAND_PATTERNS) {
        const match = pattern.exec(text);
        if (!match)
            continue;
        const title = cleanTitle(match[1]);
        if (title.length < 2)
            return null;
        // Talking about the UI ("find the videos tab") is ambiguous -> guidance.
        if (UI_REFERENCE.test(title))
            return null;
        // A second question word means the message asks how to do something.
        if (/\b(?:how|where|why|when)\b/i.test(title))
            return null;
        return title;
    }
    return null;
}
/** True only for an explicit, unambiguous search command. */
function isExplicitSearchCommand(message) {
    return extractTitle(message) !== null;
}
function detectScroll(message) {
    const text = message.toLowerCase();
    if (/\b(?:to\s+the\s+top|to\s+top|back\s+to\s+top|all\s+the\s+way\s+up)\b/.test(text))
        return 'top';
    if (/\b(?:to\s+the\s+bottom|to\s+bottom|all\s+the\s+way\s+down)\b/.test(text))
        return 'bottom';
    if (/\b(?:up|upwards)\b/.test(text))
        return 'up';
    if (/\b(?:down|downwards)\b/.test(text))
        return 'down';
    return 'down';
}
/** Pull the phrase describing what to click ("the second result", "it"). */
function detectClickTarget(message) {
    const match = /\b(?:click|tap|press|hit|open|select|choose)\s+(?:on\s+|at\s+)?(.+?)\s*[.!?]*$/i.exec(message.trim());
    if (!match)
        return undefined;
    const target = match[1].trim();
    return target.length > 0 ? target : undefined;
}
/**
 * Classify a user message.
 *
 * `search_command` is returned only when a title could be extracted, which is
 * the same condition the dialog layer uses to create a TypingGrant. Everything
 * else falls back to guidance or an explicit action request.
 */
function classifyIntent(message) {
    const text = message.trim();
    const title = extractTitle(text);
    if (title) {
        return {
            intent: 'search_command',
            title,
            reason: 'explicit search command with an extractable title',
        };
    }
    if (ACTION_SCROLL.test(text)) {
        return {
            intent: 'action',
            title: null,
            action: { type: 'scroll', direction: detectScroll(text) },
            reason: 'explicit scroll request',
        };
    }
    if (ACTION_CLICK.test(text)) {
        return {
            intent: 'action',
            title: null,
            action: { type: 'click', target: detectClickTarget(text) },
            reason: 'explicit click request',
        };
    }
    return {
        intent: 'guidance',
        title: null,
        reason: QUESTION_START.test(text)
            ? 'question about how to do something'
            : 'no explicit command: treated as guidance (never a search command)',
    };
}
/** True when the user explicitly asked for a click or scroll (spec mode table). */
function userRequestedAction(message) {
    return classifyIntent(message).intent === 'action';
}
/** Echo shown in the dialog before any typing happens. */
function grantEcho(title) {
    return `Got it - I will type "${title}" into the search box once, then press Enter.`;
}
const intentName = (intent) => intent;
exports.intentName = intentName;
//# sourceMappingURL=intent.js.map