/** "Guide me to Submit Appeal": pointing by visible text, guessed ids, links outside the snapshot. */
import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/agent/core';
import { runTool } from '../src/agent/executor';
import { locateTarget } from '../src/agent/intent';
import { stripHint } from '../src/agent/tools/pointAt';
import type { SnapElement } from '../src/shared/page';
import { assistantText, makeCtx } from './fakes';
import { portal } from './voterPortal';

const halt = () => undefined;
const APPEAL: SnapElement = {
  id: 'e90', role: 'link', name: 'Submit Appeal', rect: { x: 300, y: 1900, width: 200, height: 40 },
  inViewport: false, sensitive: false, isSearch: false, order: 9,
};

describe('"guide me to X" handled directly (no model)', () => {
  it('parses where-is-it requests', () => {
    expect(locateTarget('guide me to the submit appeal option')).toBe('submit appeal');
    expect(locateTarget('Where is Fill Form 6?')).toBe('Fill Form 6');
    expect(locateTarget('show me the "Track Application Status" link')).toBe('Track Application Status');
    expect(locateTarget('how do I register as a new voter')).toBeNull();
  });

  it('points at the label and finishes without calling the planner', async () => {
    const { host, ghost, browser, events } = portal();
    browser.hidden = [APPEAL];
    let plannerRan = false;
    const agent = new AgentCore(host, () => ({ name: 'x', async run() { plannerRan = true; }, cancel() {} }));
    await agent.handleUserMessage('guide me to the submit appeal option');
    expect(plannerRan).toBe(false);
    expect(ghost.log).toContain('hint:Here: Submit Appeal');
    expect(assistantText(events)).toContain('Submit Appeal');
    expect(browser.actions).toEqual(['scroll_into_view:e90']);
    expect(agent.state).toBe('Idle');
  });

  it('no exact match but related options (real portal: "Track Appeal"): says so and points at the closest', async () => {
    const { host, ghost, browser, events } = portal();
    const track: SnapElement = { ...APPEAL, id: 'e91', name: 'Track Appeal' };
    browser.hidden = [track];
    let plannerRan = false;
    const agent = new AgentCore(host, () => ({ name: 'x', async run() { plannerRan = true; }, cancel() {} }));
    await agent.handleUserMessage('guide me to the submit appeal option');
    expect(plannerRan).toBe(false);
    expect(assistantText(events)).toContain("couldn't find an option called **submit appeal**");
    expect(assistantText(events)).toContain('Track Appeal');
    expect(ghost.log).toContain('hint:Closest match: Track Appeal');
    expect(browser.actions.some((a) => a.startsWith('click'))).toBe(false);
  });

  it('falls back to the planner when the label is not on the page', async () => {
    const { host } = portal();
    let plannerRan = false;
    const agent = new AgentCore(host, () => ({ name: 'x', async run() { plannerRan = true; }, cancel() {} }));
    await agent.handleUserMessage('guide me to the submit appeal option');
    expect(plannerRan).toBe(true);
  });
});

describe('point_at by visible text', () => {
  it('finds a link that is not in the 60-element snapshot, scrolls to it and points', async () => {
    const { host, ghost, browser } = portal();
    browser.hidden = [APPEAL];
    const out = await runTool('point_at', { target_area: 'page', target_text: 'Submit Appeal', hint: 'Submit your appeal here' }, makeCtx(), host, halt);
    expect(out).toMatchObject({ ok: true, pointed: 'e90', matched_label: 'Submit Appeal', scrolled: 'down' });
    expect(ghost.log).toContain('hint:Submit your appeal here');
    expect(browser.actions).toEqual(['scroll_into_view:e90']); // never clicks
  });

  it('a guessed id ("e1") falls back to the hint wording instead of failing', async () => {
    const { host, browser } = portal();
    browser.hidden = [APPEAL];
    const out = await runTool('point_at', { target_area: 'page', target_id: 'e1', hint: 'Click here to Submit Appeal' }, makeCtx(), host, halt);
    expect(out).toMatchObject({ ok: true, pointed: 'e90' });
  });

  it('when the label is not on the page it says so and returns the page', async () => {
    const { host } = portal();
    const out = await runTool('point_at', { target_area: 'page', target_text: 'Submit Appeal', hint: 'Appeal' }, makeCtx(), host, halt);
    expect(out.error).toMatch(/could not find "Submit Appeal"/);
    expect(String(out.page)).toContain('<page>');
  });

  it('quoting the visible label in the hint is UI guidance, not an unsourced fact', async () => {
    const { host, browser } = portal();
    browser.hidden = [APPEAL];
    const out = await runTool('point_at', { target_area: 'page', target_text: 'Submit Appeal', hint: "Click 'Submit Appeal' to file your appeal" }, makeCtx(), host, halt);
    expect(out).toMatchObject({ ok: true, pointed: 'e90' });
  });

  it('a quoted made-up fact in a hint is still rejected', async () => {
    const { host } = portal();
    const out = await runTool('point_at', { target_area: 'page', target_id: 'e10', hint: 'Appeals are decided in "15 days"' }, makeCtx(), host, halt);
    expect(out.error).toMatch(/hint rejected/);
  });

  it('stripHint turns a hint into the label to look for', () => {
    expect(stripHint("Click 'Submit Appeal'")).toBe('Submit Appeal');
    expect(stripHint('Click here to Submit Appeal')).toBe('Submit Appeal');
    expect(stripHint('Click on Fill Form 6 here.')).toBe('Fill Form 6');
  });
});
