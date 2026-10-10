/**
 * Shared guard helpers used inside every tool's execute() (spec 8.4).
 * The model cannot bypass these: they run in code whatever the model says.
 */
import type { PageSnapshot, SnapElement } from '../shared/page';
import { redactText } from '../rag/redact';
import type { Chunk } from './grounding';
import { checkGrounding } from './grounding';
import type { Host, Point, TaskContext } from './types';
import { throwIfAborted } from './types';

export const TELEGRAPH_PAUSE_MS = 400;

/**
 * Text that asks the user to hand over personal identifiers in chat. Rule 7/13
 * and the injection defense: never ask for, repeat, or type these.
 */
const ASK_PERSONAL = [
  /\b(tell|share|send|give|provide|type|paste|enter|write|confirm)\s+(me|us|it\s+here|here|in\s+(the\s+)?chat)\b[^.?!]{0,60}\b(aadhaa?r|epic|otp|one.?time|password|pin|mobile|phone|date of birth|dob)\b/i,
  /\b(what\s+is|what's|whats)\s+your\s+(aadhaa?r|epic|voter.?id|otp|password|mobile|phone)\b/i,
  /\b(need|require|want)\s+your\s+(aadhaa?r|epic|voter.?id)\s*(number|no\.?)?\b[^.?!]{0,30}\b(here|chat|me)\b/i,
  // "send/share/tell me your EPIC number please" (but NOT "Enter your EPIC number here",
  // which is a legitimate hint pointing at the field the user fills in themselves).
  /\b(send|share|tell|give)\s+(me\s+|us\s+)?(your|the)\s+(aadhaa?r|epic)\s+(number|no\.?)\b/i,
];

export function asksForPersonalData(text: string): boolean {
  return ASK_PERSONAL.some((re) => re.test(text));
}

/** Validates user-facing model text (reply, point_at hint, finish). */
export function checkUserFacingText(
  text: string,
  kind: 'ui' | 'fact',
  sourceIds: string[] | undefined,
  chunks: Map<string, Chunk>,
): { ok: true; isFact: boolean } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: 'text is empty' };
  if (asksForPersonalData(text)) {
    return {
      ok: false,
      reason:
        'never ask the user to share Aadhaar/EPIC numbers, OTPs, passwords, phone numbers or dates of birth. At those fields point and say the user must do it themselves',
    };
  }
  if (redactText(text) !== text) {
    return { ok: false, reason: 'the text contains something that looks like a personal ID or contact; remove it' };
  }
  return checkGrounding(text, kind, sourceIds, chunks);
}

export function citationsFor(ids: string[] | undefined, chunks: Map<string, Chunk>) {
  const seen = new Set<string>();
  const out = [];
  for (const id of ids ?? []) {
    const chunk = chunks.get(id);
    if (!chunk) continue;
    const key = `${chunk.citation.source_url}|${chunk.citation.section_path}|${chunk.citation.pages.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { org, doc_title, section_path, pages, publication_date, source_url } = chunk.citation;
    out.push({ org, doc_title, section_path, pages, publication_date, source_url });
  }
  return out;
}

export function findElement(snapshot: PageSnapshot | null, id: string): SnapElement | null {
  return snapshot?.elements.find((e) => e.id === id) ?? null;
}

export function center(rect: { x: number; y: number; width: number; height: number }): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Ghost flight time: 300 to 900 ms by distance (spec 6.2). */
export function flightMs(from: Point | null, to: Point): number {
  if (!from) return 500;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(900, Math.max(300, 300 + distance * 0.6)));
}

/**
 * Telegraph (rule 5): ghost moves to the target, pulses, shows the hint, waits
 * ~400 ms. The caller runs the action only after this resolves. Halts if the
 * overlay is gone (rule 2).
 */
export async function telegraph(host: Host, ctx: TaskContext, to: Point, hint?: string, pulse = true): Promise<void> {
  if (!host.ghost.alive) {
    // Give a just-started or just-restored overlay a moment to come back before halting.
    await host.sleep(600, ctx.signal);
    if (!host.ghost.alive) throw new Error('ghost overlay is not visible; halting (rule 2)');
  }
  throwIfAborted(ctx.signal);
  const ms = flightMs(ctx.ghostAt, to);
  host.ghost.move(to.x, to.y, ms);
  ctx.ghostAt = to;
  await host.sleep(ms, ctx.signal);
  if (pulse) host.ghost.pulse(to.x, to.y);
  if (hint) host.ghost.hint(hint, to.x, to.y);
  await host.sleep(TELEGRAPH_PAUSE_MS, ctx.signal);
  throwIfAborted(ctx.signal);
}

/** Compact, redacted page description for the model, inside a <page> data block. */
export function describePage(snapshot: PageSnapshot | null): string {
  if (!snapshot) return '<page>\n(no page loaded)\n</page>';
  const lines = snapshot.elements.map((e) => {
    const flags = [e.inViewport ? 'visible' : 'offscreen'];
    if (e.sensitive) flags.push('SENSITIVE-user-only');
    if (e.isSearch) flags.push('search-box');
    const name = redactText(e.name).replace(/\s+/g, ' ').slice(0, 80);
    return `${e.id} | ${e.role} #${e.order} | "${name}" | ${flags.join(',')}`;
  });
  return [
    '<page>',
    `url: ${redactText(snapshot.url)}`,
    `title: ${redactText(snapshot.title)}`,
    `scroll: ${snapshot.scrollY}/${Math.max(0, snapshot.scrollHeight - snapshot.viewport.height)}`,
    `search_box: ${snapshot.searchFieldId ?? 'none'}`,
    'elements (id | role #order | name | flags):',
    ...lines,
    '</page>',
  ].join('\n');
}

export function describeTabs(tabs: { id: string; title: string; url: string }[], activeId: string | null): string {
  const lines = tabs.map(
    (t) => `${t.id}${t.id === activeId ? ' (active)' : ''} | ${redactText(t.title).slice(0, 60)} | ${redactText(t.url)}`,
  );
  return ['<tabs>', ...lines, '</tabs>'].join('\n');
}
