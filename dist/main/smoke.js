"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSmokeTest = runSmokeTest;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate())
            return true;
        await sleep(150);
    }
    return predicate();
}
/** Tool name of a logged tool_call record. */
function toolOf(record) {
    const call = record.data?.['call'];
    return typeof call?.tool === 'string' ? call.tool : '';
}
async function runSmokeTest(deps) {
    const { agent, bridge, overlay, dialog, logger } = deps;
    const checks = [];
    const record = (name, pass, detail) => {
        checks.push({ name, pass, detail });
        if (pass)
            logger.info('system', `smoke PASS ${name}`, { detail });
        else
            logger.error('system', `smoke FAIL ${name}`, { detail });
    };
    logger.info('system', 'smoke test started');
    // 1. The ghost overlay is up and answering its heartbeat.
    const ready = await until(() => overlay.isReady, 10_000);
    record('overlay renderer ready', ready, `isReady=${overlay.isReady}`);
    await sleep(2_600);
    record('overlay heartbeat alive', overlay.alive, `alive=${overlay.alive} (interval 1s, timeout 2.5s)`);
    record('dialog panel alive', dialog.alive, `hotkey=${dialog.currentHotkey}`);
    // 2. Perceive over CDP.
    let elementCount = -1;
    let searchFieldId = null;
    try {
        const snapshot = await bridge.snapshot();
        elementCount = snapshot.elements.length;
        searchFieldId = snapshot.searchFieldId;
    }
    catch (error) {
        record('cdp snapshot', false, String(error));
    }
    record('cdp snapshot', elementCount > 0, `${elementCount} interactive elements, search field ${searchFieldId ?? 'none'}`);
    // 3. Guidance: the ghost points, nothing is clicked, Esc ends the wait.
    const callsBefore = logger.recordsOf('tool_call').length;
    const stopper = setTimeout(() => agent.handleEsc('smoke guidance'), 6_000);
    await agent.handleUserMessage('where is the search box on this page?');
    clearTimeout(stopper);
    const guidanceCalls = logger.recordsOf('tool_call').slice(callsBefore);
    const pointed = guidanceCalls.some((entry) => toolOf(entry) === 'point_at');
    const clicked = guidanceCalls.some((entry) => toolOf(entry) === 'click');
    record('guidance points without acting', pointed && !clicked, `tools: ${guidanceCalls.map(toolOf).join(', ') || 'none'}`);
    record('guidance task ended in Idle', agent.state === 'Idle', `state=${agent.state}`);
    // 4. Search command: one grant, one type, one Enter, all over CDP.
    const grantsBefore = logger.recordsOf('grant').length;
    const resultsBefore = logger.recordsOf('tool_result').length;
    await agent.handleUserMessage('search for ghost cursor prototype');
    const grants = logger.recordsOf('grant').slice(grantsBefore);
    const results = logger.recordsOf('tool_result').slice(resultsBefore);
    const created = grants.some((entry) => entry.message.includes('created'));
    const consumed = grants.some((entry) => entry.message.includes('consumed'));
    const typed = results.some((entry) => entry.message === 'type_in_search succeeded');
    const entered = results.some((entry) => entry.message === 'press_enter succeeded');
    const verified = logger
        .recordsOf('system')
        .some((entry) => entry.message === 'typed text verified' && entry.data?.['matches'] === true);
    record('typing grant created and consumed', created && consumed, grants.map((entry) => entry.message).join(' | ') || 'no grant records');
    record('cdp typing into the search box', typed, results.map((entry) => entry.message).join(' | ') || 'no tool results');
    record('typed title verified against the page', verified, 'searchFieldValue equals the title');
    record('cdp Enter submitted the search', entered, `state=${agent.state}`);
    // 5. Esc stops a task, double Esc halts, "resume" clears the halt.
    agent.handleEsc('smoke first');
    agent.handleEsc('smoke second');
    record('double Escape halts automation', agent.state === 'Halted', `state=${agent.state}`);
    await agent.handleUserMessage('resume');
    record('resume clears the halt', agent.state === 'Idle', `state=${agent.state}`);
    const failed = checks.filter((check) => !check.pass);
    logger.info('system', `smoke test finished: ${checks.length - failed.length}/${checks.length} checks passed`, { failed: failed.map((check) => check.name) });
    /* eslint-disable no-console */
    console.log('\n===== Ghost Cursor smoke test =====');
    for (const check of checks) {
        console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name} :: ${check.detail}`);
    }
    console.log(failed.length === 0
        ? '===== SMOKE PASS =====\n'
        : `===== SMOKE FAIL (${failed.length} of ${checks.length}) =====\n`);
    /* eslint-enable no-console */
    return failed.length === 0;
}
//# sourceMappingURL=smoke.js.map