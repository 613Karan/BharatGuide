"use strict";
/**
 * Injected page listener (spec sections 7 and 8: `wait_for_user`).
 *
 * One-way only: the page reports what the *user* did (focus, click, input,
 * Escape, navigation) back to the agent core over a CDP binding. Nothing here
 * synthesizes input, and the only value ever reported is the search box value.
 *
 * Serialized into the page, so no module-scope runtime values may be referenced.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.installPageListener = installPageListener;
function installPageListener() {
    const scoped = window;
    if (scoped.__gcListenerInstalled)
        return;
    scoped.__gcListenerInstalled = true;
    const report = (payload) => {
        try {
            if (typeof scoped.__ghostReport === 'function')
                scoped.__ghostReport(payload);
        }
        catch {
            // Reporting must never break the page.
        }
    };
    const isSearchField = (node) => {
        const input = node;
        const type = (input.type || '').toLowerCase();
        if (type === 'search')
            return true;
        if ((node.getAttribute('role') || '').toLowerCase() === 'searchbox')
            return true;
        const identity = `${input.name || ''} ${input.id || ''}`.toLowerCase();
        if (/(?:^|[\s_-])q(?:$|[\s_-])|query|search/.test(identity))
            return true;
        const label = (node.getAttribute('aria-label') ||
            node.getAttribute('placeholder') ||
            '')
            .toLowerCase()
            .trim();
        return /^search\b|^suche\b|search the web/.test(label);
    };
    const describe = (target) => {
        if (!(target instanceof Element))
            return {};
        const info = {
            elementId: target.getAttribute('data-gc-id'),
            role: target.getAttribute('role') ||
                target.tagName.toLowerCase(),
        };
        const name = target.getAttribute('aria-label') ||
            target.getAttribute('placeholder') ||
            target.getAttribute('title') ||
            (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (name)
            info.name = name;
        // Values are reported only for the search box.
        if (isSearchField(target)) {
            info.value = target.value ?? '';
        }
        return info;
    };
    document.addEventListener('focusin', (event) => {
        report({ type: 'focus', at: Date.now(), url: location.href, ...describe(event.target) });
    }, true);
    document.addEventListener('click', (event) => {
        report({ type: 'click', at: Date.now(), url: location.href, ...describe(event.target) });
    }, true);
    document.addEventListener('input', (event) => {
        report({ type: 'input', at: Date.now(), url: location.href, ...describe(event.target) });
    }, true);
    // Escape reaches the agent even when the dialog is hidden: this is the user's
    // own key press, reported - never synthesized.
    document.addEventListener('keydown', (event) => {
        const keyEvent = event;
        if (keyEvent.key !== 'Escape' && keyEvent.key !== 'Enter')
            return;
        report({
            type: 'keydown',
            at: Date.now(),
            key: keyEvent.key,
            url: location.href,
            ...describe(event.target),
        });
    }, true);
    let lastScrollReport = 0;
    window.addEventListener('scroll', () => {
        const now = Date.now();
        if (now - lastScrollReport < 250)
            return;
        lastScrollReport = now;
        report({ type: 'scroll', at: now, url: location.href });
    }, { passive: true });
    // Announce the document the listener was installed into.
    report({ type: 'navigation', at: Date.now(), url: location.href });
}
//# sourceMappingURL=listenerScript.js.map