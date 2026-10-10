/** Real-task demo ("register as a new voter") + fast planner model plumbing. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../src/agent/core';
import { createFastModel, toOpenAiMessages } from '../src/agent/fastModel';
import { JUDGES_DEMO_MESSAGE, REGISTER_ANSWER, REGISTER_DEMO_MESSAGE, RegisterDemoPlanner } from '../src/agent/registerDemoPlanner';
import { assistantText, okResponse } from './fakes';
import { portal } from './voterPortal';

// Text from the real eci_docs_small Form-6 chunks (abridged).
const REAL_FORM6 = [
  'ELECTION COMMISSION OF INDIA Form-6 Application Form for New Voters. Self attested copy of document supporting age proof: Birth certificate, Aadhaar Card.',
  'Self-attested copy of address proof: Water/Electricity/Gas connection Bill for that address, Aadhaar Card, Current passbook of Nationalized/Scheduled Bank/Post Office, Indian Passport.',
];

describe('register-as-new-voter demo', () => {
  it('searches, gives a cited answer, opens the portal, points at Form 6, waits for the user, never clicks or types', async () => {
    const { host, browser, ghost, events } = portal();
    host.rag = { search: async () => okResponse(REAL_FORM6) };
    const agent = new AgentCore(host, (deps) => new RegisterDemoPlanner(deps, browser, host.logger));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    await agent.handleUserMessage(REGISTER_DEMO_MESSAGE);
    vi.useRealTimers();

    const text = assistantText(events);
    expect(text).toContain('Form 6');
    expect(text).toContain('Age proof');
    expect(events.some((e) => e.t === 'assistant_end' && (e as { sources?: unknown[] }).sources?.length)).toBe(true);
    expect(browser.actions).toContain('navigate:https://voters.eci.gov.in/');
    expect(browser.actions.some((a) => a.startsWith('click'))).toBe(false); // the user clicks, not the assistant
    expect(browser.typed).toEqual([]);
    expect(ghost.log.some((h) => /^hint:.*Form 6/.test(h))).toBe(true);
    expect(ghost.log.some((h) => /^hint:.*yourself/i.test(h))).toBe(true); // EPIC field: user does it
    expect(agent.state).toBe('Idle');
  }, 20_000);

  it('judges variant: same guarded flow, then hands control back to the user (live planner next)', async () => {
    const { host, browser, events } = portal();
    host.rag = { search: async () => okResponse(REAL_FORM6) };
    let calls = 0;
    const agent = new AgentCore(host, (deps) => (calls++, new RegisterDemoPlanner(deps, browser, host.logger, 'judges')));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    await agent.handleUserMessage(JUDGES_DEMO_MESSAGE);
    vi.useRealTimers();

    const text = assistantText(events);
    expect(text).toContain('Form 6');
    expect(text).toMatch(/you are in control/i);
    expect(browser.actions).toContain('navigate:https://voters.eci.gov.in/');
    expect(browser.actions.some((a) => a.startsWith('click'))).toBe(false);
    expect(browser.typed).toEqual([]);
    expect(agent.state).toBe('Idle');
    expect(calls).toBe(1);
  }, 20_000);

  it('the scripted answer passes the fact guard against the real chunk text', async () => {
    const { checkUserFacingText } = await import('../src/agent/guardrails');
    const chunks = new Map(REAL_FORM6.map((text, i) => [`S${i + 1}`, { id: `S${i + 1}`, text, citation: okResponse().results[0].citation }]));
    expect(checkUserFacingText(REGISTER_ANSWER, 'fact', ['S1', 'S2'], chunks)).toEqual({ ok: true, isFact: true });
  });
});

describe('fast model (thinking off)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('converts SDK messages, tool calls and tool results to OpenAI chat format', () => {
    const out = toOpenAiMessages('sys', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'reply', input: { text: 'x' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'reply', output: { ok: true } }] },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'reply', arguments: '{"text":"x"}' } }] });
    expect(out.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: '{"ok":true}' });
  });

  it('sends reasoning_effort and maps tool calls to SDK events', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'finish', arguments: '{"message":"done"}' } }] } }] }),
      );
    });
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const model = createFastModel({ baseUrl: 'http://x/v1', modelId: 'm', apiKey: 'k', reasoningEffort: 'none' }, log);
    const events = [];
    for await (const e of await model.stream({ messages: [], tools: [] })) events.push(e);
    expect(sent.reasoning_effort).toBe('none');
    expect(events).toEqual([
      { type: 'tool-call-delta', index: 0, toolCallId: 'c1', toolName: 'finish', inputText: '{"message":"done"}' },
      { type: 'finish', reason: 'tool-calls' },
    ]);
  });
});
