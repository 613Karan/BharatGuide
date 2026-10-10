/**
 * Sensitive-field detection (spec 6.7). The same rules are embedded into the
 * in-page snapshot script (pageScripts.ts) through SENSITIVE_NAME_SOURCE, so the
 * unit tests here exercise exactly what runs in the page.
 */
export const SENSITIVE_NAME_SOURCE = String.raw`otp|one.?time|password|passcode|aadhaa?r|uid|epic|voter.?id|card|cvv|pin\b`;
export const SENSITIVE_AUTOCOMPLETE_SOURCE = String.raw`^(one-time-code|cc-|current-password|new-password)`;

const NAME_RE = new RegExp(SENSITIVE_NAME_SOURCE, 'i');
const AUTOCOMPLETE_RE = new RegExp(SENSITIVE_AUTOCOMPLETE_SOURCE, 'i');

export type FieldDescriptor = {
  tag: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
};

export function isSensitiveField(field: FieldDescriptor): boolean {
  const tag = field.tag.toLowerCase();
  const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'textbox';
  if (!isField) return false;
  if ((field.type ?? '').toLowerCase() === 'password') return true;
  if (AUTOCOMPLETE_RE.test((field.autocomplete ?? '').trim())) return true;
  const identity = [field.name, field.id, field.placeholder, field.label].filter(Boolean).join(' ');
  return NAME_RE.test(identity);
}

/** An element inside a <form> that contains any sensitive field is sensitive too. */
export function isSensitiveInForm(formFields: FieldDescriptor[]): boolean {
  return formFields.some(isSensitiveField);
}
