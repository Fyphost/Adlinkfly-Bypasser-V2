/**
 * SSRF-safe server-side HTTP client used to resolve known URL redirectors
 * (t.co, bit.ly, …) that sit between the shortener and the real destination.
 * Only HEAD (or a GET whose body is never read) requests are made, and every
 * connection uses the validated, pinned address from {@link SafeResolver}.
 */
import http from 'node:http';
import https from 'node:https';
import type { SafeResolver } from '../security/resolver.ts';
import type { UrlPolicy } from '../security/urlPolicy.ts';

export interface HeadResult {
  status: number;
  location: string | null;
}

export class SafeHttpClient {
  private readonly resolver: SafeResolver;
  private readonly policy: UrlPolicy;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: { resolver: SafeResolver; policy: UrlPolicy; timeoutMs?: number; userAgent?: string }) {
    this.resolver = options.resolver;
    this.policy = options.policy;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent = options.userAgent ?? 'Mozilla/5.0 (compatible; LinkResolver/1.0)';
  }

  async probe(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<HeadResult> {
    const u = new URL(url);
    const verdict = this.policy.checkNetworkUrl(u);
    if (!verdict.allowed) throw new Error(`blocked by policy: ${verdict.reason}`);
    await this.resolver.resolve(u.hostname); // validate before connecting (also warms the pinned cache)
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise<HeadResult>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method,
          headers: { 'user-agent': this.userAgent, accept: '*/*' },
          lookup: this.resolver.lookupFunction(),
          timeout: this.timeoutMs,
        },
        (res) => {
          const loc = res.headers.location;
          resolve({ status: res.statusCode ?? 0, location: typeof loc === 'string' ? loc : null });
          res.destroy();
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * Follows HTTP redirects while the current URL is on a redirector host.
 * The first non-redirector URL is returned without being requested.
 */
export async function followRedirectors(
  start: string,
  client: SafeHttpClient,
  options: { maxHops: number; isRedirector: (host: string) => boolean },
): Promise<{ url: string; hops: string[] }> {
  let current = start;
  const hops: string[] = [];
  for (let i = 0; i < options.maxHops; i++) {
    const host = new URL(current).hostname;
    if (!options.isRedirector(host)) break;
    let res: HeadResult;
    try {
      res = await client.probe(current, 'HEAD');
      if (res.status === 405 || res.status === 501) res = await client.probe(current, 'GET');
    } catch {
      break; // keep the last known URL; the redirector is unreachable
    }
    if (res.status < 300 || res.status >= 400 || !res.location) break;
    let next: URL;
    try {
      next = new URL(res.location, current);
    } catch {
      break;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
    hops.push(current);
    current = next.href;
  }
  return { url: current, hops };
}
