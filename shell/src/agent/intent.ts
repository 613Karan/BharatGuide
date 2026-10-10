/**
 * Intent classification in code, by the chat layer (spec 8.9). This module is
 * the ONLY origin of a TypingGrant. The planner can never create one.
 */
export type Intent =
  | { kind: 'search_command'; title: string }
  | { kind: 'guidance'; userAskedClick: boolean; userAskedScroll: boolean };

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyIntent(message: string, phrases: string[]): Intent {
  const text = message.trim();
  const alternatives = phrases.map(escape).join('|') || 'search for|find';
  const match = new RegExp(`^(?:please\\s+)?(?:${alternatives})\\s+(.+)$`, 'i').exec(text);
  if (match) {
    let title = match[1].trim();
    const quoted = /^["“'](.+?)["”']/.exec(title);
    if (quoted) title = quoted[1];
    title = title.replace(/\s+on\s+youtube\.?$/i, '').replace(/[.?!]+$/, '').trim();
    // "find the register button" is guidance, not a video search.
    const looksLikeUi = /^(the\s+)?(button|link|tab|field|box|form|menu|page|option)\b/i.test(title) ||
      /\b(button|link|field|box|menu)$/i.test(title);
    if (title && title.length <= 120 && !looksLikeUi) return { kind: 'search_command', title };
  }
  const lowered = text.toLowerCase();
  return {
    kind: 'guidance',
    userAskedClick: /\b(click|press|tap|open it|select it|choose it)\b/.test(lowered),
    userAskedScroll: /\bscroll\b/.test(lowered),
  };
}
