"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentCore = void 0;
const types_1 = require("../../shared/types");
const guardrails_1 = require("./guardrails");
const heuristicPlanner_1 = require("./heuristicPlanner");
const intent_1 = require("./intent");
const sanitize_1 = require("./sanitize");
const stateMachine_1 = require("./stateMachine");
const telegraph_1 = require("./telegraph");
const typingGrant_1 = require("./typingGrant");
const MAX_STEPS = 14;
const NAVIGATION_WAIT_MS = 10_000;
class AgentCore {
    bridge;
    overlay;
    dialog;
    logger;
    planner;
    machine = new stateMachine_1.StateMachine();
    grants;
    task = null;
    history = [];
    denial = null;
    lastSuccessfulTool = null;
    lastCursor = null;
    attempt = 1;
    failures = 0;
    loopRunning = false;
    abortRequested = false;
    settled = true;
    lastEscAt = 0;
    unsubscribe = null;
    constructor(options) {
        this.bridge = options.bridge;
        this.overlay = options.overlay;
        this.dialog = options.dialog;
        this.logger = options.logger;
        this.planner = options.planner ?? new heuristicPlanner_1.HeuristicPlanner();
        // Grants are logged wherever they change; created only from a user message.
        this.grants = new typingGrant_1.GrantStore({
            onCreated: (grant) => this.logger.grant('created', grant),
            onConsumed: (grant) => this.logger.grant('consumed', grant),
            onDropped: (reason, grant) => this.logger.grant('dropped', grant, reason),
        });
    }
    get state() {
        return this.machine.state;
    }
    /** Wire events, calibrate the coordinate mapping and greet the user. */
    async start() {
        this.machine.onChange((from, to, trigger) => {
            this.logger.stateChange(from, to, trigger);
            this.dialog.setStatus(to, hintForState(to));
            if (to === 'Idle' || to === 'Halted') {
                this.overlay.thinking(false);
                this.overlay.hide();
            }
        });
        this.unsubscribe = this.bridge.onPageEvent((event) => this.handlePageEvent(event));
        try {
            const calibration = await this.bridge.calibrate();
            this.logger.info('system', 'coordinate mapping calibrated', {
                ok: calibration.ok,
                delta: calibration.delta,
                source: calibration.geometry.source,
                scale: calibration.geometry.scale,
                viewportLeft: calibration.geometry.viewportLeft,
                viewportTop: calibration.geometry.viewportTop,
            });
            if (!calibration.ok) {
                this.dialog.say('My coordinate mapping is uncertain, so I will point and describe instead of clicking.');
            }
        }
        catch (error) {
            this.logger.error('system', 'calibration failed', { error: String(error) });
        }
        this.dialog.setStatus(this.machine.state, hintForState(this.machine.state));
        this.dialog.say('Hi, I am Ghost Cursor. Ask me how to do something and I will point at it with my ghost cursor. ' +
            'Say "search for <title>" and I will type that title once and press Enter. Esc stops me, twice halts me.');
    }
    /**
     * Page events (spec section 11). Escape reaches the agent even when the dialog
     * is hidden, because the injected listener reports it over CDP.
     */
    handlePageEvent(event) {
        if (event.type === 'keydown' && event.key === 'Escape') {
            this.handleEsc('page Escape');
            return;
        }
        if (event.type === 'navigation') {
            this.logger.info('system', 'page navigated', { url: event.url ?? null });
        }
    }
    /** One Escape stops the current task, two in a row halt everything. */
    handleEsc(source) {
        const now = Date.now();
        const doubleEsc = now - this.lastEscAt <= types_1.DOUBLE_ESC_WINDOW_MS;
        this.lastEscAt = now;
        if (doubleEsc) {
            this.halt(`double Escape (${source})`);
            return;
        }
        this.abortTask(`Escape (${source})`);
    }
    /** Stop the current task, drop the grant, go back to Idle. */
    abortTask(source) {
        this.abortRequested = true;
        this.settled = true;
        // End an in-flight "wait for the user" at once, so the stop is immediate.
        this.bridge.cancelWaits();
        const taskId = this.task?.taskId ?? null;
        this.grants.drop(`stopped by user (${source})`);
        this.returnToIdle();
        this.overlay.thinking(false);
        this.overlay.hide();
        this.dialog.say('Stopped. Nothing else will happen until you write again.');
        this.logger.warn('halt', 'task stopped by user', { source, taskId });
        this.clearTask();
    }
    /** Hard stop: no tool may be dispatched until the user says "resume". */
    halt(reason) {
        this.abortRequested = true;
        this.settled = true;
        this.bridge.cancelWaits();
        this.grants.drop(`halted (${reason})`);
        this.machine.halt();
        this.overlay.thinking(false);
        this.overlay.hide();
        this.logger.halt(reason);
        this.dialog.say(`Halted: ${reason}. Write "resume" and I will continue.`);
        this.clearTask();
    }
    resume() {
        const transition = this.machine.apply('resume');
        this.abortRequested = false;
        this.settled = true;
        this.failures = 0;
        if (transition.ok)
            this.dialog.say('Resumed. Ask me anything and I will point at it.');
        else
            this.dialog.say('I was not halted, so there is nothing to resume.');
    }
    /** The ghost overlay stopped answering: never act without a visible cursor. */
    handleOverlayLost() {
        this.halt('the ghost overlay stopped answering');
    }
    /**
     * A message submitted in the dialog. This is the dialog layer: it is the only
     * place that may create a TypingGrant, and it only does so for an explicit
     * search command with an extractable title (spec section 2, rule 4).
     */
    async handleUserMessage(text) {
        const trimmed = text.trim();
        if (trimmed.length === 0)
            return;
        this.dialog.echoUser(trimmed);
        if (/^(resume|continue|weiter|weitermachen)$/i.test(trimmed)) {
            this.resume();
            return;
        }
        if (this.machine.state === 'Halted') {
            this.dialog.say('I am halted. Write "resume" first and I will continue.');
            return;
        }
        if (this.loopRunning) {
            this.dialog.say('I am still working on the last message. Esc stops it.');
            return;
        }
        const intent = (0, intent_1.classifyIntent)(trimmed);
        this.logger.info('plan', `intent ${intent.intent}`, {
            intent: intent.intent,
            reason: intent.reason,
            title: intent.title,
        });
        this.clearTask();
        this.abortRequested = false;
        this.settled = false;
        this.task = {
            taskId: `task-${Date.now()}`,
            message: trimmed,
            userRequestedAction: intent.intent === 'action',
        };
        if (intent.intent === 'search_command' && intent.title) {
            this.grants.create(this.task.taskId, intent.title);
            this.dialog.say((0, intent_1.grantEcho)(intent.title));
            this.returnToIdle();
            const transition = this.machine.apply('search_command');
            if (!transition.ok) {
                this.dialog.say(`I cannot run a search right now (${transition.reason}).`);
                this.finishTask();
                return;
            }
        }
        else {
            this.grants.drop('the message was not a search command');
            if (this.machine.state === 'Idle')
                this.machine.apply('user_message');
            else if (this.machine.state === 'AwaitingUser')
                this.machine.apply('user_acted');
            else if (this.machine.state === 'RunningCommand')
                this.returnToIdle();
        }
        await this.runLoop();
    }
    clearTask() {
        this.task = null;
        this.history = [];
        this.denial = null;
        this.lastSuccessfulTool = null;
        this.attempt = 1;
        this.failures = 0;
    }
    /** RunningCommand -> Guiding -> Idle, using only legal transitions. */
    returnToIdle() {
        if (this.machine.state === 'RunningCommand')
            this.machine.apply('results_shown');
        if (this.machine.state === 'AwaitingUser' || this.machine.state === 'Guiding') {
            this.machine.apply('finish_or_timeout');
        }
    }
    /** The one loop: perceive -> plan -> validate -> telegraph -> act -> verify. */
    async runLoop() {
        if (this.loopRunning)
            return;
        this.loopRunning = true;
        this.overlay.thinking(true);
        try {
            for (let step = 0; step < MAX_STEPS; step += 1) {
                if (this.settled || this.abortRequested || this.machine.state === 'Halted')
                    break;
                const snapshot = await this.perceive();
                if (!snapshot) {
                    this.dialog.say('I cannot read this page right now, so I stopped.');
                    this.finishTask();
                    break;
                }
                const context = this.buildContext(snapshot);
                const allowed = (0, guardrails_1.allowedTools)(context);
                const request = this.buildRequest(snapshot, context, allowed);
                const proposal = await this.planner.plan(request);
                this.logger.info('plan', `${this.planner.name} proposed ${proposal.tool}`, {
                    step,
                    state: context.state,
                    mode: context.mode,
                    allowedTools: allowed,
                    proposal,
                });
                const decision = (0, guardrails_1.validateToolCall)(proposal, context);
                if (!decision.ok) {
                    this.logger.denied(proposal, decision.reason);
                    this.denial = { tool: proposal.tool, reason: decision.reason };
                    this.failures += 1;
                    this.dialog.say(`I will not ${proposal.tool}: ${decision.reason}`);
                    if (this.failures >= types_1.MAX_FAILED_ATTEMPTS) {
                        this.finishTask('I could not find a safe next step, so I stopped. Nothing was forced.');
                    }
                    continue;
                }
                this.denial = null;
                this.logger.toolCall(decision.call, {
                    step,
                    state: context.state,
                    mode: context.mode,
                    notes: decision.notes,
                    taskId: this.task?.taskId ?? null,
                });
                const result = await this.executeCall(decision.call, snapshot);
                this.logger.toolResult(result);
                this.history.push({
                    tool: result.tool,
                    ok: result.ok,
                    detail: result.ok ? result.detail : result.reason,
                });
                if (result.ok) {
                    this.lastSuccessfulTool = result.tool;
                    this.failures = 0;
                }
                else {
                    // A failed step also clears the ordering guard: Enter is never retried.
                    this.lastSuccessfulTool = null;
                    this.failures += 1;
                }
                this.attempt += 1;
                if (result.ok && result.tool === 'press_enter') {
                    this.finishTask('Done: the search ran and the results are on the page. Your turn.');
                }
                if (!this.settled && this.failures >= types_1.MAX_FAILED_ATTEMPTS) {
                    this.finishTask('That did not work after several attempts, so I stopped.');
                }
            }
            if (!this.settled && !this.abortRequested && this.machine.state !== 'Halted') {
                this.finishTask('I reached my step limit, so I stopped here.');
            }
        }
        catch (error) {
            this.logger.error('system', 'agent loop crashed', { error: String(error) });
            this.dialog.say(`Something went wrong and I stopped: ${String(error)}`);
            this.finishTask();
        }
        finally {
            this.loopRunning = false;
            this.overlay.thinking(false);
        }
    }
    /** Perceive: one fresh snapshot per step, never a cached one. */
    async perceive() {
        try {
            const snapshot = await this.bridge.snapshot();
            this.logger.info('system', 'snapshot taken', {
                snapshotId: snapshot.snapshotId,
                url: snapshot.url,
                elements: snapshot.elements.length,
                searchFieldId: snapshot.searchFieldId,
                poor: (0, guardrails_1.snapshotIsPoor)(snapshot),
            });
            return snapshot;
        }
        catch (error) {
            this.logger.warn('system', 'snapshot failed', { error: String(error) });
            return null;
        }
    }
    buildContext(snapshot) {
        return {
            state: this.machine.state,
            mode: this.machine.mode,
            grant: this.grants.current,
            userRequestedAction: this.task?.userRequestedAction ?? false,
            lastSuccessfulTool: this.lastSuccessfulTool,
            snapshot,
            now: Date.now(),
        };
    }
    buildRequest(snapshot, context, allowed) {
        const usable = this.grants.isUsable(context.now);
        return {
            taskId: this.task?.taskId ?? 'none',
            userMessage: this.task?.message ?? '',
            state: context.state,
            mode: context.mode,
            allowedTools: allowed,
            snapshot: (0, sanitize_1.sanitizeSnapshot)(snapshot),
            history: [...this.history],
            denial: this.denial,
            hasTypingGrant: usable.ok,
            grantedTitle: usable.ok ? (this.grants.current?.text ?? null) : null,
            userRequestedAction: context.userRequestedAction,
            attempt: this.attempt,
        };
    }
    /**
     * Telegraph (spec section 5, step 4): the ghost visibly moves to the target,
     * pauses at least 400 ms and pulses. Only afterwards may CDP input follow.
     */
    async telegraphElement(bbox, hint) {
        try {
            const geometry = await this.bridge.geometry();
            const result = await (0, telegraph_1.telegraph)({
                overlay: this.overlay,
                geometry,
                bbox,
                hint,
                from: this.lastCursor,
            });
            this.lastCursor = result.target;
            return result.onScreen ? result.target : null;
        }
        catch (error) {
            this.logger.warn('system', 'telegraph failed', { error: String(error) });
            return null;
        }
    }
    /** Act: dispatch through the bridge only, then verify what the page did. */
    async executeCall(call, snapshot) {
        switch (call.tool) {
            case 'point_at': {
                const element = (0, guardrails_1.findElement)(snapshot, call.args.element_id);
                if (!element) {
                    return { ok: false, tool: 'point_at', reason: 'that element is no longer on the page' };
                }
                await this.telegraphElement(element.bbox, call.args.hint);
                this.overlay.hint(call.args.hint);
                this.dialog.say(`I am pointing at ${labelFor(element)}.`);
                const transition = this.machine.apply('ghost_pointed');
                if (!transition.ok) {
                    this.logger.warn('state', 'ghost_pointed not applied', { reason: transition.reason });
                }
                return { ok: true, tool: 'point_at', detail: `pointed at ${element.id} (${element.role})` };
            }
            case 'click': {
                const element = (0, guardrails_1.findElement)(snapshot, call.args.element_id);
                if (!element) {
                    return { ok: false, tool: 'click', reason: 'that element is no longer on the page' };
                }
                await this.telegraphElement(element.bbox, `Clicking ${labelFor(element)}`);
                if (this.abortRequested || this.machine.state === 'Halted') {
                    return { ok: false, tool: 'click', reason: 'stopped before the click was dispatched' };
                }
                const action = await this.bridge.click(call.args.element_id);
                const result = actionToResult('click', action);
                if (result.ok)
                    this.dialog.say(`Clicked ${labelFor(element)} through CDP.`);
                return result;
            }
            case 'scroll': {
                this.overlay.ripple();
                if (call.args.hint)
                    this.overlay.hint(call.args.hint);
                const action = await this.bridge.scroll(call.args.direction, call.args.amount);
                const result = actionToResult('scroll', action);
                if (result.ok)
                    this.dialog.say(`Scrolled ${call.args.direction}.`);
                return result;
            }
            case 'type_in_search': {
                const fieldId = snapshot.searchFieldId;
                if (!fieldId) {
                    return { ok: false, tool: 'type_in_search', reason: 'this page has no main search field' };
                }
                const field = (0, guardrails_1.findElement)(snapshot, fieldId);
                if (field)
                    await this.telegraphElement(field.bbox, `Typing here: ${call.args.text}`);
                if (this.abortRequested || this.machine.state === 'Halted') {
                    return { ok: false, tool: 'type_in_search', reason: 'stopped before typing' };
                }
                const action = await this.bridge.typeInSearch(call.args.text, fieldId);
                if (!action.ok) {
                    this.grants.drop('typing failed');
                    return {
                        ok: false,
                        tool: 'type_in_search',
                        reason: action.reason ?? 'the page refused the typing',
                    };
                }
                // Verify: the search box really holds the granted title, nothing else.
                if (!(await this.verifyTypedText(call.args.text))) {
                    this.grants.drop('verification failed');
                    return {
                        ok: false,
                        tool: 'type_in_search',
                        reason: 'verification failed: the search box does not hold the granted title',
                    };
                }
                this.grants.consume();
                this.dialog.say(`Typed "${call.args.text}" into the search box. Enter comes next.`);
                return { ok: true, tool: 'type_in_search', detail: 'granted title typed and verified' };
            }
            case 'press_enter': {
                const fieldId = snapshot.searchFieldId;
                const field = fieldId ? (0, guardrails_1.findElement)(snapshot, fieldId) : null;
                if (field)
                    await this.telegraphElement(field.bbox, 'Pressing Enter');
                else
                    this.overlay.pulse();
                if (this.abortRequested || this.machine.state === 'Halted') {
                    return { ok: false, tool: 'press_enter', reason: 'stopped before Enter' };
                }
                const action = await this.bridge.pressEnter();
                if (!action.ok) {
                    return {
                        ok: false,
                        tool: 'press_enter',
                        reason: action.reason ?? 'the page refused the Enter key',
                    };
                }
                // Verify: wait for the results page instead of assuming it appeared.
                const event = await this.bridge.waitForPageEvent('navigation', NAVIGATION_WAIT_MS);
                const transition = this.machine.apply('results_shown');
                if (!transition.ok) {
                    this.logger.warn('state', 'results_shown not applied', { reason: transition.reason });
                }
                this.grants.drop('the search was submitted');
                return {
                    ok: true,
                    tool: 'press_enter',
                    detail: event ? 'navigation observed' : 'no navigation observed within the wait window',
                };
            }
            case 'wait_for_user': {
                const timeoutMs = call.args.timeoutMs ?? types_1.DEFAULT_WAIT_TIMEOUT_MS;
                const hint = call.args.hint ?? 'Your turn: your real mouse and keyboard stay yours.';
                // Waiting happens in AwaitingUser, so the ghost points first.
                if (this.machine.state === 'Guiding')
                    this.machine.apply('ghost_pointed');
                this.overlay.hint(hint);
                this.dialog.say(hint);
                // The ghost is not busy while the user acts, so the thinking indicator stops.
                this.overlay.thinking(false);
                const event = await this.bridge.waitForPageEvent(call.args.event, timeoutMs);
                this.overlay.thinking(true);
                if (this.abortRequested || this.machine.state === 'Halted') {
                    return { ok: false, tool: 'wait_for_user', reason: 'stopped while waiting' };
                }
                if (!event) {
                    this.finishTask('I waited and nothing happened, so I stopped. Write again when you are ready.');
                    return {
                        ok: false,
                        tool: 'wait_for_user',
                        reason: `no ${call.args.event} event within ${timeoutMs} ms`,
                    };
                }
                this.machine.apply('user_acted');
                return { ok: true, tool: 'wait_for_user', detail: `the user did something (${event.type})` };
            }
            case 'finish': {
                this.finishTask(call.args.message);
                return { ok: true, tool: 'finish', detail: call.args.message };
            }
        }
    }
    /** Verify (spec section 5, step 6): read back the one value we may read. */
    async verifyTypedText(expected) {
        try {
            const after = await this.bridge.snapshot();
            const actual = after.searchFieldValue ?? '';
            const matches = actual === expected;
            this.logger.info('system', 'typed text verified', { matches });
            return matches;
        }
        catch (error) {
            this.logger.warn('system', 'typed text verification failed', { error: String(error) });
            return false;
        }
    }
    /** End of a task: grant dropped, state back to Idle, ghost hidden. */
    finishTask(message) {
        if (this.settled)
            return;
        this.settled = true;
        const taskId = this.task?.taskId ?? null;
        this.grants.drop('the task finished');
        this.returnToIdle();
        this.overlay.thinking(false);
        this.overlay.hide();
        if (message)
            this.dialog.say(message);
        this.logger.info('system', 'task finished', { taskId, state: this.machine.state });
        this.clearTask();
    }
    /** Clean shutdown: nothing keeps running after the app quits. */
    async shutdown() {
        this.abortRequested = true;
        this.settled = true;
        this.bridge.cancelWaits();
        this.grants.drop('shutdown');
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.overlay.thinking(false);
        this.overlay.hide();
        this.logger.info('system', 'agent core stopped');
    }
}
exports.AgentCore = AgentCore;
/** Status line under the dialog chip (spec section 9). */
function hintForState(state) {
    switch (state) {
        case 'Guiding':
            return 'Guiding: I am looking at the page.';
        case 'AwaitingUser':
            return 'Your turn: use your own mouse and keyboard.';
        case 'RunningCommand':
            return 'Running your search command.';
        case 'Halted':
            return 'Halted: write "resume" and I will continue.';
        default:
            return 'Idle: ask a question or say "search for <title>".';
    }
}
/** Short human-readable name for an element, used in dialog sentences. */
function labelFor(element) {
    const raw = (element.name || element.role || element.tag || 'element').trim();
    return raw.length > 60 ? `${raw.slice(0, 60)}...` : raw;
}
/** Bridge results are internal; the loop and the log use ToolResult. */
function actionToResult(tool, action) {
    if (action.ok) {
        return { ok: true, tool, detail: action.detail ? JSON.stringify(action.detail) : undefined };
    }
    return { ok: false, tool, reason: action.reason ?? 'the page refused the action' };
}
//# sourceMappingURL=core.js.map