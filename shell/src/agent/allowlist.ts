/**
 * URL allowlist (spec 6.5). A URL passes only if it is https: and its host is
 * in ALLOWED_HOSTS or is the host of a source_url returned by search_docs in
 * THIS task. The reason for a rejection is returned to the model.
 */
export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

export function checkUrl(raw: string, allowedHosts: string[], taskSourceHosts: Iterable<string>): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid absolute URL` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `only https: URLs are allowed (got ${url.protocol})` };
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  const host = url.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  for (const h of taskSourceHosts) allowed.add(h.toLowerCase());
  if (!allowed.has(host)) {
    return {
      ok: false,
      reason: `host "${host}" is not allowlisted. Allowed: official ECI/UIDAI sites, google.com, youtube.com, or a source_url from search_docs in this task`,
    };
  }
  return { ok: true, url: url.toString(), host };
}

export function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}
