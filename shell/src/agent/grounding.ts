/**
 * Grounding check (spec 8.4). A backstop, not proof of correctness.
 *
 * Text containing a form ID, a currency amount, a duration, or a quoted name
 * is treated as FACT regardless of the declared kind. Fact text needs at least
 * one source_id that exists in ctx.chunks, and every matched item must appear
 * (case-insensitive, whitespace-normalized) in the cited chunks' text.
 */
export type Chunk = { id: string; text: string; citation: import('../shared/ipc').Citation & { retrieved_at?: string } };

export type GroundingResult = { ok: true; isFact: boolean } | { ok: false; reason: string };

const FORM_ID = /\bForm[\s-]*\d+[A-Z]?\b/gi;
const AMOUNT = /(₹|Rs\.?|INR)\s*\d[\d,]*/gi;
const DURATION = /\b\d+\s*(?:days?|weeks?|months?|years?)\b/gi;
// "double quotes", “curly quotes” or 'single quotes' around 3+ chars
const QUOTED = /["“]([^"”]{3,80})["”]|(?<![A-Za-z])'([^']{3,80})'(?![A-Za-z])/g;

export function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Form IDs compare without the separator, so "Form-6B" matches "Form 6B". */
function normForm(text: string): string {
  return norm(text).replace(/form[\s-]*/g, 'form ');
}

/** "Rs. 1,000" matches "Rs 1000" and "₹1000" by the digits. */
function amountDigits(text: string): string {
  return text.replace(/[^\d]/g, '');
}

export type FactItems = { forms: string[]; amounts: string[]; durations: string[]; quoted: string[] };

export function extractFactItems(text: string): FactItems {
  const forms = [...text.matchAll(FORM_ID)].map((m) => m[0]);
  const amounts = [...text.matchAll(AMOUNT)].map((m) => m[0]);
  const durations = [...text.matchAll(DURATION)].map((m) => m[0]);
  const quoted = [...text.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  return { forms, amounts, durations, quoted };
}

export function looksFactual(items: FactItems): boolean {
  return items.forms.length + items.amounts.length + items.durations.length + items.quoted.length > 0;
}

export function checkGrounding(
  text: string,
  kind: 'ui' | 'fact',
  sourceIds: string[] | undefined,
  chunks: Map<string, Chunk>,
): GroundingResult {
  const items = extractFactItems(text);
  const isFact = kind === 'fact' || looksFactual(items);
  if (!isFact) return { ok: true, isFact: false };

  const ids = (sourceIds ?? []).filter(Boolean);
  if (ids.length === 0) {
    return {
      ok: false,
      reason:
        'this message states a fact (form, fee, duration, document or step) but has no source_ids. Call search_docs and cite source ids from this task',
    };
  }
  const unknown = ids.filter((id) => !chunks.has(id));
  if (unknown.length) {
    return { ok: false, reason: `unknown source_ids ${unknown.join(', ')}: cite only ids returned by search_docs in this task` };
  }

  const cited = ids.map((id) => chunks.get(id)!.text).join('\n');
  const citedNorm = norm(cited);
  const citedForms = normForm(cited);
  const citedDigits = [...cited.matchAll(AMOUNT)].map((m) => amountDigits(m[0]));

  for (const form of items.forms) {
    if (!citedForms.includes(normForm(form))) {
      return { ok: false, reason: `"${form}" does not appear in the cited sources` };
    }
  }
  for (const amount of items.amounts) {
    const digits = amountDigits(amount);
    if (!citedDigits.includes(digits)) {
      return { ok: false, reason: `the amount "${amount}" does not appear in the cited sources` };
    }
  }
  for (const duration of items.durations) {
    if (!citedNorm.includes(norm(duration))) {
      return { ok: false, reason: `the duration "${duration}" does not appear in the cited sources` };
    }
  }
  for (const name of items.quoted) {
    if (!citedNorm.includes(norm(name))) {
      return { ok: false, reason: `the quoted name "${name}" does not appear in the cited sources` };
    }
  }
  return { ok: true, isFact: true };
}
