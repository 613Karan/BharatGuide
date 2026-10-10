/** "Click on voter ID" end to end through AgentCore with a scripted planner. */
import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/agent/core';
import { scripted } from './scripted';
import { portal } from './voterPortal';

describe('click on voter ID: end to end', () => {
  it('click e-EPIC link -> model tries EPIC field (refused) -> points instead -> finish', async () => {
    const { host, browser, events } = portal();
    const { factory, results } = scripted([
      { tool: 'click', input: { element_id: 'e11' } },
      { tool: 'click', input: { element_id: 'e13' } }, // model mistake: refused in code
      { tool: 'point_at', input: { target_area: 'page', target_id: 'e13', hint: 'Enter your EPIC number here' } },
      { tool: 'finish', input: { message: 'I opened the e-EPIC page. Please enter your EPIC number yourself.' } },
    ]);
    const agent = new AgentCore(host, factory);
    await agent.handleUserMessage('click on voter id');
    expect(results.map((r) => Boolean(r.error))).toEqual([false, true, false, false]);
    expect(browser.actions.filter((a) => a.startsWith('click'))).toEqual(['click:410,240']);
    expect(browser.typed).toEqual([]);
    expect(events.filter((e) => e.t === 'status').map((e) => (e as { text: string | null }).text)).toContain('Double-checking…');
    expect(agent.state).toBe('Idle');
  });

  it('a message containing the user\'s EPIC number is redacted before the planner sees it', async () => {
    const { host, events } = portal();
    let seen = '';
    const agent = new AgentCore(host, () => ({ name: 'x', async run(m) { seen = m; }, cancel() {} }));
    await agent.handleUserMessage('my voter id is ABC1234567, click on download');
    expect(seen).not.toContain('ABC1234567');
    expect(events).toContainEqual(expect.objectContaining({ t: 'card', kind: 'redaction' }));
  });
});
