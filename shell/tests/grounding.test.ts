/** Spec §11: grounding unit tests, redaction, personal-data asks, sensitive fields, allowlist. */
import { describe, expect, it } from 'vitest';
import { checkUrl } from '../src/agent/allowlist';
import { checkGrounding, type Chunk } from '../src/agent/grounding';
import { asksForPersonalData } from '../src/agent/guardrails';
import { isSensitiveField } from '../src/bridge/sensitive';
import { REDACTED, redact, redactDeep } from '../src/rag/redact';
import { FORM6_CHUNK } from './fakes';

const chunks = new Map<string, Chunk>([
  ['S1', { id: 'S1', text: FORM6_CHUNK, citation: { org: 'ECI', doc_title: 'G', section_path: '1', pages: [1], publication_date: '2022-07-20', source_url: 'https://voters.eci.gov.in/x.pdf' } }],
]);

describe('grounding check', () => {
  it('rejects a fact reply without source_ids', () => {
    expect(checkGrounding('Fill Form 6 to register.', 'fact', [], chunks).ok).toBe(false);
  });
  it('treats a form ID as fact even when declared ui', () => {
    expect(checkGrounding('Use Form 6B for this.', 'ui', undefined, chunks).ok).toBe(false);
  });
  it('rejects a form / fee / duration / quoted name missing from the cited chunks', () => {
    expect(checkGrounding('Fill Form 8 now.', 'fact', ['S1'], chunks).ok).toBe(false);
    expect(checkGrounding('The fee is Rs. 50.', 'fact', ['S1'], chunks).ok).toBe(false);
    expect(checkGrounding('It takes 90 days.', 'fact', ['S1'], chunks).ok).toBe(false);
    expect(checkGrounding('Attach "Birth Certificate".', 'fact', ['S1'], chunks).ok).toBe(false);
  });
  it('rejects unknown source ids', () => {
    expect(checkGrounding('Fill Form 6.', 'fact', ['S9'], chunks).ok).toBe(false);
  });
  it('accepts a correct cited reply (case, whitespace, separator normalized)', () => {
    const r = checkGrounding('Fill form-6 and attach "proof of age". A decision comes within 30  days.', 'fact', ['S1'], chunks);
    expect(r).toEqual({ ok: true, isFact: true });
  });
  it('plain UI text passes without sources', () => {
    expect(checkGrounding('Click the button I am pointing at.', 'ui', [], chunks)).toEqual({ ok: true, isFact: false });
  });
});

describe('redaction', () => {
  it('redacts Aadhaar (with/without spaces), EPIC, mobile and email', () => {
    const { text, redacted } = redact('aadhaar 1234 5678 9012 / 123456789012, EPIC ABC1234567, call +91 98765 43210, mail a@b.co');
    expect(redacted).toBe(true);
    expect(text).not.toMatch(/\d{4}/);
    expect(text).not.toContain('ABC1234567');
    expect(text).not.toContain('a@b.co');
    expect(text.split(REDACTED).length - 1).toBe(5);
  });
  it('leaves procedural text alone', () => {
    expect(redact('Fill Form 6B, fee Rs. 50, within 30 days, PIN 110001').redacted).toBe(false);
  });
  it('redacts nested log data', () => {
    expect(JSON.stringify(redactDeep({ input: { text: 'my number 9876543210' } }))).not.toContain('9876543210');
  });
  it('flags text that asks the user for personal identifiers', () => {
    expect(asksForPersonalData('Please share your Aadhaar number here so I can help.')).toBe(true);
    expect(asksForPersonalData('What is your EPIC number?')).toBe(true);
    expect(asksForPersonalData('Send me your EPIC number please.')).toBe(true);
    expect(asksForPersonalData('Enter your Aadhaar number in the form yourself; never share it in chat.')).toBe(false);
    expect(asksForPersonalData('Enter your EPIC number here')).toBe(false);
  });
});

describe('sensitive-field detection (spec 6.7)', () => {
  it.each([
    [{ tag: 'input', type: 'password' }, true],
    [{ tag: 'input', autocomplete: 'one-time-code' }, true],
    [{ tag: 'input', autocomplete: 'cc-number' }, true],
    [{ tag: 'input', name: 'aadhaarNo' }, true],
    [{ tag: 'input', placeholder: 'Enter EPIC number' }, true],
    [{ tag: 'input', label: 'Voter ID' }, true],
    [{ tag: 'input', name: 'q', placeholder: 'Search' }, false],
    [{ tag: 'button', label: 'Login with OTP' }, false],
  ])('%o -> %s', (field, expected) => {
    expect(isSensitiveField(field)).toBe(expected);
  });
});

describe('URL allowlist', () => {
  const hosts = ['voters.eci.gov.in', 'www.youtube.com'];
  it('rejects non-allowlisted hosts and plain http', () => {
    expect(checkUrl('https://evil.example.com/', hosts, []).ok).toBe(false);
    expect(checkUrl('http://voters.eci.gov.in/', hosts, []).ok).toBe(false);
  });
  it('accepts allowlisted hosts and source_url hosts from this task', () => {
    expect(checkUrl('https://voters.eci.gov.in/', hosts, []).ok).toBe(true);
    expect(checkUrl('https://ecisveep.nic.in/x', hosts, ['ecisveep.nic.in']).ok).toBe(true);
  });
});
