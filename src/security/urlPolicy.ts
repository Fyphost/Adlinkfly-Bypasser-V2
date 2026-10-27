/**
 * URL validation, sanitisation and egress policy (scheme, port, host and
 * deny-list checks). DNS-based checks live in {@link SafeResolver}; this module
 * performs the fast, synchronous checks applied to every URL and request.
 */
import { AppError } from '../errors.ts';
import { CidrSet, classifyIp, isIpLiteral } from './ip.ts';

export const MAX_URL_LENGTH = 2048;

const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'home.arpa',
  'corp',
  'private',
  'onion',
  'invalid',
];

export interface UrlPolicyOptions {
  allowedPorts: Set<number> | 'any';
  allowPrivateCidrs: string[];
  domainDenylist: string[];
}

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export function hostMatches(host: string, domain: string): boolean {
  const d = domain.replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
}

export function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function normaliseHostname(hostname: string): string {
  return stripBrackets(hostname.toLowerCase()).replace(/\.$/, '');
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

export class UrlPolicy {
  readonly allowedPorts: Set<number> | 'any';
  readonly allowPrivate: CidrSet;
  readonly domainDenylist: string[];

  constructor(options: UrlPolicyOptions) {
    this.allowedPorts = options.allowedPorts;
    this.allowPrivate = new CidrSet(options.allowPrivateCidrs);
    this.domainDenylist = options.domainDenylist;
  }

  isPortAllowed(port: number): boolean {
    return this.allowedPorts === 'any' || this.allowedPorts.has(port);
  }

  /** Checks whether a resolved IP address may be contacted. */
  checkAddress(address: string): PolicyVerdict {
    const c = classifyIp(address);
    if (c.public) return { allowed: true };
    if (this.allowPrivate.contains(address)) return { allowed: true };
    return { allowed: false, reason: `address ${c.address} is ${c.reason ?? 'not public'}` };
  }

  /** Synchronous host checks (no DNS): literal IPs, internal names, deny-list. */
  checkHost(rawHost: string): PolicyVerdict {
    const host = normaliseHostname(rawHost);
    if (!host) return { allowed: false, reason: 'empty host' };
    if (host.length > 253) return { allowed: false, reason: 'host name too long' };
    if (isIpLiteral(host)) return this.checkAddress(host);
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
      return { allowed: false, reason: 'host name contains invalid characters' };
    }
    if (!host.includes('.')) return { allowed: false, reason: 'single-label host names are not allowed' };
    for (const suffix of INTERNAL_SUFFIXES) {
      if (hostMatches(host, suffix)) return { allowed: false, reason: `internal host name (.${suffix})` };
    }
    for (const d of this.domainDenylist) {
      if (hostMatches(host, d)) return { allowed: false, reason: `host ${host} is deny-listed` };
    }
    return { allowed: true };
  }

  /** Checks any URL the browser or server-side client is about to request. */
  checkNetworkUrl(input: URL | string): PolicyVerdict {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : input;
    } catch {
      return { allowed: false, reason: 'unparseable URL' };
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return { allowed: false, reason: `scheme ${url.protocol} is not allowed` };
    }
    const port = effectivePort(url);
    if (!this.isPortAllowed(port)) return { allowed: false, reason: `port ${port} is not allowed` };
    return this.checkHost(url.hostname);
  }

  /**
   * Validates and normalises a URL submitted by an API client.
   * Throws {@link AppError} INVALID_URL or URL_NOT_ALLOWED.
   */
  parseSubmittedUrl(input: unknown): URL {
    if (typeof input !== 'string') {
      throw new AppError('INVALID_URL', { detail: 'The "url" field must be a string' });
    }
    let s = input.trim();
    if (s.length === 0) throw new AppError('INVALID_URL', { detail: 'The "url" field must not be empty' });
    if (s.length > MAX_URL_LENGTH) {
      throw new AppError('INVALID_URL', { detail: `The URL must not exceed ${MAX_URL_LENGTH} characters` });
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\s]/.test(s)) {
      throw new AppError('INVALID_URL', { detail: 'The URL must not contain whitespace or control characters' });
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
      if (scheme && !scheme[1]!.includes('.') && !/^\d+$/.test(s.slice(scheme[0].length).split('/')[0] ?? '')) {
        throw new AppError('INVALID_URL', { detail: 'Only http and https URLs are supported' });
      }
      s = `https://${s}`;
    }
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new AppError('INVALID_URL', { detail: 'The URL could not be parsed' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('INVALID_URL', { detail: 'Only http and https URLs are supported' });
    }
    if (url.username || url.password) {
      throw new AppError('INVALID_URL', { detail: 'URLs with embedded credentials are not allowed' });
    }
    if (!url.hostname) throw new AppError('INVALID_URL', { detail: 'The URL must contain a host name' });
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const verdict = this.checkNetworkUrl(url);
    if (!verdict.allowed) throw new AppError('URL_NOT_ALLOWED', { detail: `The URL is not permitted: ${verdict.reason}` });
    return url;
  }
}

/** Cache / de-duplication key for a submitted URL (fragment removed). */
export function urlCacheKey(url: URL): string {
  const u = new URL(url.href);
  u.hash = '';
  return u.href;
}
