/**
 * Separates the real destination from redirect wrappers and tracking noise.
 *
 *  - Known redirect wrappers (google.com/url?q=, l.facebook.com/l.php?u=, …)
 *    are unwrapped locally, without any network request.
 *  - On pages that belong to the shortener flow, generic "?url=<target>"
 *    parameters (plain, percent-encoded or base64-encoded) are unwrapped.
 *  - Pure tracking parameters (utm_*, fbclid, gclid, …) can be stripped.
 */

interface WrapperRule {
  host: RegExp;
  path?: RegExp;
  params?: string[];
  /** Target is the raw query string itself (e.g. href.li/?https://…). */
  rawQuery?: boolean;
}

const WRAPPERS: WrapperRule[] = [
  { host: /(^|\.)google\.[a-z.]{2,6}$/, path: /^\/url$/, params: ['q', 'url'] },
  { host: /^(l|lm)\.facebook\.com$|^l\.messenger\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.instagram\.com$/, params: ['u'] },
  { host: /^out\.reddit\.com$/, params: ['url'] },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
  { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ['z'] },
  { host: /^(away\.|m\.)?vk\.com$/, path: /^\/away\.php$/, params: ['to'] },
  { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, params: ['url', 'u'] },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/redir\/redirect\/?$/, params: ['url'] },
  { host: /safelinks\.protection\.outlook\.com$/, params: ['url'] },
  { host: /^click\.linksynergy\.com$/, params: ['murl'] },
  { host: /^(www\.)?href\.li$/, rawQuery: true },
  { host: /^(www\.)?anonym\.to$/, rawQuery: true },
  { host: /^(www\.)?dereferer\.me$/, rawQuery: true },
  { host: /^(www\.)?nullrefer\.com$/, rawQuery: true },
  { host: /^(www\.)?anonymz\.com$/, rawQuery: true },
];

/** Hosts that only redirect elsewhere; they are resolved with a HEAD request (see redirectFollower). */
export const SHORT_REDIRECTOR_HOSTS: readonly string[] = [
  't.co',
  'bit.ly',
  'bitly.com',
  'j.mp',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'v.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  'tiny.cc',
  's.id',
  'lnkd.in',
  'trib.al',
  'dlvr.it',
  'ift.tt',
  'fb.me',
  'amzn.to',
  't.ly',
];

export function isShortRedirectorHost(host: string): boolean {
  const h = host.toLowerCase();
  return SHORT_REDIRECTOR_HOSTS.includes(h) || SHORT_REDIRECTOR_HOSTS.some((d) => h === `www.${d}`);
}

const GENERIC_TARGET_PARAMS = [
  'url',
  'u',
  'link',
  'target',
  'dest',
  'destination',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'redirecturl',
  'goto',
  'go',
  'to',
  'out',
  'r',
  'href',
  'site',
];

const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|igsh|yclid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|mkt_tok|vero_id|vero_conv|oly_anon_id|oly_enc_id|rb_clickid|s_cid|twclid|ttclid|li_fat_id|_openstat|spm|scid)$/i;

function asHttpUrl(candidate: string): string | null {
  const v = candidate.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Decodes a parameter value that may be percent-encoded (possibly twice) or base64(url)-encoded. */
export function decodeTargetValue(value: string): string | null {
  let v = value;
  for (let i = 0; i < 3; i++) {
    const direct = asHttpUrl(v);
    if (direct) return direct;
    try {
      const dec = decodeURIComponent(v);
      if (dec === v) break;
      v = dec;
    } catch {
      break;
    }
  }
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(b64) && b64.length >= 12) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      // eslint-disable-next-line no-control-regex
      if (!/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) {
        const u = asHttpUrl(decoded);
        if (u) return u;
      }
    } catch {
      /* not base64 */
    }
  }
  return null;
}

/** Unwraps a well-known redirect wrapper; returns null when the URL is not a wrapper. */
export function unwrapKnownWrapper(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  for (const rule of WRAPPERS) {
    if (!rule.host.test(host)) continue;
    if (rule.path && !rule.path.test(u.pathname)) continue;
    if (rule.rawQuery) {
      const q = u.search.slice(1);
      const t = q ? decodeTargetValue(q) : null;
      if (t) return t;
      continue;
    }
    for (const p of rule.params ?? []) {
      const v = u.searchParams.get(p);
      if (v) {
        const t = decodeTargetValue(v);
        if (t) return t;
      }
    }
  }
  return null;
}

/** Unwraps "?url=<target>" style parameters. Only applied to URLs on shortener-flow hosts. */
export function unwrapGenericParam(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  for (const [k, v] of u.searchParams) {
    if (!GENERIC_TARGET_PARAMS.includes(k.toLowerCase()) || !v) continue;
    const t = decodeTargetValue(v);
    if (t) return t;
  }
  return null;
}

export function stripTrackingParams(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  const keys = [...new Set([...u.searchParams.keys()])];
  let changed = false;
  for (const k of keys) {
    if (TRACKING_PARAM.test(k)) {
      u.searchParams.delete(k);
      changed = true;
    }
  }
  if (!changed) return input;
  return u.href.replace(/\?$/, '').replace(/\?#/, '#');
}
