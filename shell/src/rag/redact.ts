/**
 * Personal-data redaction (spec rule 13). Mirrors rag/redact.py; keep in sync.
 * Applied to user text before anything else, and to everything that is logged.
 */
export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Email first, so digits inside an address do not leave fragments.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Aadhaar: 12 digits, optionally grouped 4-4-4 by spaces or hyphens.
  /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g,
  // EPIC: 3 letters followed by 7 digits.
  /\b[A-Za-z]{3}\d{7}\b/g,
  // Mobile: optional +91 / 91 / 0 prefix, then 10 digits starting 6-9.
  /(?<!\d)(?:\+?91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g,
];

export function redact(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return { text: out, redacted: out !== text };
}

export function redactText(text: string): string {
  return redact(text).text;
}

/** Deep-redact any JSON-like value (used by the logger). */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item);
    return out;
  }
  return value;
}
