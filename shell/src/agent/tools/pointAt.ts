import { z } from 'zod';
import { center, checkUserFacingText, describePage, telegraph } from '../guardrails';
import type { Host, ToolDef } from '../types';

const schema = z.object({
  target_area: z.enum(['page', 'toolbar']).describe('"page" for an element of the web page, "toolbar" for the browser toolbar'),
  target_id: z
    .string()
    .optional()
    .describe('page: element id from <page> like "e12". toolbar: "address_bar", "back", "forward", "reload", "new_tab" or "tab:<tab id>"'),
  target_text: z
    .string()
    .max(80)
    .optional()
    .describe('page only: the visible label to find, e.g. "Submit Appeal". Use this when the element is not listed in <page>; the whole page is searched.'),
  hint: z.string().min(1).max(140).describe('One short line shown next to the ghost, e.g. "Click here to register"'),
  kind: z.enum(['ui', 'fact']).default('ui'),
  source_ids: z.array(z.string()).optional(),
});

const SELF_HINT = /yourself|you (need|have) to|please (enter|type|fill|do)/i;

export const pointAt: ToolDef<z.infer<typeof schema>> = {
  name: 'point_at',
  description:
    'Fly the ghost cursor to an element and show a one-line hint. Give target_id from <page>, or target_text with the visible label (e.g. "Submit Appeal") to search the whole page, including parts not listed in <page>. Off-screen elements are scrolled into view first. Never clicks. For login/OTP/Aadhaar/EPIC/payment fields, point and tell the user to do it themselves.',
  schema,
  async execute(input, ctx, host) {
    let hint = input.hint.trim();
    // Quoting a label that is visible on the page ("Click 'Submit Appeal'") is UI
    // guidance, not a sourced fact: remove those quotes before the fact check.
    const labels = await pageLabels(host, input.target_text);
    // Text that is a visible page label (e.g. "Fill Form 6") is UI guidance, not
    // a sourced claim: remove it before the fact check. The rest of the hint is
    // still checked, so "Form 6 takes 30 days" next to it is rejected.
    const unlabeled = stripPageLabels(unquotePageLabels(hint, labels), labels);
    const check = checkUserFacingText(unlabeled, input.kind, input.source_ids, ctx.chunks);
    if (!check.ok) return { error: `hint rejected: ${check.reason}` };

    if (input.target_area === 'toolbar') {
      const rect = input.target_id ? host.browser.toolbarRect(input.target_id) : null;
      if (!rect) return { error: `unknown toolbar target "${input.target_id ?? ''}"` };
      await telegraph(host, ctx, center(rect), hint);
      return { ok: true, pointed: input.target_id };
    }

    // Resolve the element: by id from <page>, else by visible text across the
    // whole page (the snapshot lists only 60 elements, so far-down links like
    // "Submit Appeal" may be missing from it). Models also guess ids ("e1"),
    // so an unknown id falls back to the text, or to the hint wording.
    let targetId = input.target_id;
    let info = targetId ? await host.browser.elementInfo(targetId) : ({ found: false } as const);
    let matched: string | undefined;
    if (!info.found) {
      const text = input.target_text || stripHint(hint);
      const hit = text ? await host.browser.findByText(text) : null;
      if (!hit) {
        return {
          error: `could not find "${text || targetId}" on this page. Check the latest <page>, use target_text with the exact visible label, or tell the user it is not on this page`,
          page: describePage(await host.browser.snapshot()),
        };
      }
      targetId = hit.id;
      matched = hit.name;
      info = await host.browser.elementInfo(targetId);
      if (!info.found) return { error: `"${text}" disappeared from the page; take a fresh look` };
    }
    const id = targetId as string;
    const origin = host.browser.pageOrigin();
    const size = host.browser.pageSize();
    let scrolled: 'up' | 'down' | undefined;
    if (!info.inViewport) {
      // Off screen: telegraph the scroll at the edge, then actually bring the
      // element into view so the ghost can point at it. Scrolling only reveals
      // content; it never clicks or types (spec 6.3).
      const below = info.rect.y > 0;
      scrolled = below ? 'down' : 'up';
      const x = origin.x + Math.min(Math.max(info.rect.x + info.rect.width / 2, 40), size.width - 40);
      const y = origin.y + (below ? size.height - 30 : 30);
      await telegraph(host, ctx, { x, y }, below ? 'Scrolling down' : 'Scrolling up', false);
      host.ghost.ripple(x, y);
      await host.browser.scrollIntoView(id);
      await host.sleep(700, ctx.signal); // smooth scroll settles
      info = await host.browser.elementInfo(id);
      if (!info.found) return { error: `element ${id} disappeared after scrolling; take a fresh look at the page` };
      if (!info.inViewport) {
        await telegraph(host, ctx, { x, y }, below ? 'Scroll down' : 'Scroll up');
        return { ok: true, offscreen: true, note: `could not scroll the element into view; the user was asked to scroll ${scrolled}` };
      }
    }
    if (info.sensitive && !SELF_HINT.test(hint)) hint = `${hint} (please do this yourself)`;
    const c = center(info.rect);
    await telegraph(host, ctx, { x: origin.x + c.x, y: origin.y + c.y }, hint);
    ctx.shownToUser = true;
    const extra = {
      ...(matched ? { matched_label: matched } : {}),
      ...(scrolled ? { scrolled, page: describePage(await host.browser.snapshot()) } : {}),
    };
    return info.sensitive
      ? { ok: true, pointed: id, sensitive: true, ...extra, note: 'sensitive field: the user must fill this themselves; never click or type here' }
      : { ok: true, pointed: id, ...extra };
  },
};

const QUOTED_LABEL = /["“'‘]([^"”'’]{2,80})["”'’]/g;

/** Visible labels on the current page (+ the requested target text, which is verified by findByText). */
async function pageLabels(host: Host, targetText?: string): Promise<string[]> {
  const snap = await host.browser.snapshot().catch(() => null);
  const names = (snap?.elements ?? []).map((e) => e.name.toLowerCase());
  return targetText ? [...names, targetText.toLowerCase()] : names;
}

/** Drop the quote marks around text that is a visible page label, so it is not treated as a quoted fact. */
export function unquotePageLabels(hint: string, labels: string[]): string {
  return hint.replace(QUOTED_LABEL, (whole, inner: string) => {
    const label = inner.trim().toLowerCase();
    return labels.some((l) => l.includes(label)) ? inner : whole;
  });
}

/**
 * Remove exact (case-insensitive) occurrences of visible page labels from the
 * hint, longest first. Only labels of 6+ chars count, so short words such as
 * "Form" or "Home" cannot be used to hide a made-up fact.
 */
export function stripPageLabels(hint: string, labels: string[]): string {
  const usable = [...new Set(labels.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  let out = hint;
  for (const label of usable) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    out = out.replace(new RegExp(escaped, 'gi'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim() || 'here';
}

/** "Click here to submit an appeal" -> "submit an appeal": the hint usually names the target. */
export function stripHint(hint: string): string {
  return hint
    .replace(/\(please do this yourself\)/i, '')
    .replace(/["“”'‘’]/g, '')
    .replace(/^(click|tap|press|select|open|choose|go to|use|find)\s+(on\s+)?(here\s+)?(to\s+)?/i, '')
    .replace(/^(this|here)\s+(is|to)\s+/i, '')
    .replace(/\s+(here|now|below|above)\.?$/i, '')
    .replace(/[.!]+$/, '')
    .trim()
    .slice(0, 80);
}
