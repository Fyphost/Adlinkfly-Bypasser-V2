/**
 * Turns a raw destination candidate into the verified final destination URL.
 */
import { AppError } from '../errors.ts';
import { hostMatches } from '../security/urlPolicy.ts';
import { followRedirectors, type SafeHttpClient } from './redirectFollower.ts';
import { isShortRedirectorHost, stripTrackingParams, unwrapGenericParam, unwrapKnownWrapper } from './unwrap.ts';

export interface FinalizeOptions {
  stripTracking: boolean;
  followTrackingRedirects: boolean;
  maxRedirectHops: number;
  destinationDenylist: string[];
  isFlowHost: (host: string) => boolean;
  httpClient?: SafeHttpClient;
  /** Aborts redirector probing when the job is cancelled or times out. */
  signal?: AbortSignal;
}

export interface FinalizedDestination {
  url: string;
  /** Intermediate wrapper / redirector URLs that were peeled off. */
  unwrapped: string[];
}

function parseHttp(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError('UNEXPECTED_PAGE', { detail: 'The extracted destination is not a valid URL' });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('UNEXPECTED_PAGE', { detail: `The extracted destination uses an unsupported scheme (${u.protocol})` });
  }
  return u;
}

export async function finalizeDestination(raw: string, opts: FinalizeOptions): Promise<FinalizedDestination> {
  let current = parseHttp(raw).href;
  const unwrapped: string[] = [];

  const peel = () => {
    for (let i = 0; i < 5; i++) {
      const host = new URL(current).hostname.toLowerCase();
      const next = unwrapKnownWrapper(current) ?? (opts.isFlowHost(host) ? unwrapGenericParam(current) : null);
      if (!next || next === current) break;
      unwrapped.push(current);
      current = parseHttp(next).href;
    }
  };

  peel();
  if (opts.followTrackingRedirects && opts.httpClient && opts.maxRedirectHops > 0) {
    const host = new URL(current).hostname;
    if (isShortRedirectorHost(host)) {
      const followed = await followRedirectors(current, opts.httpClient, {
        maxHops: opts.maxRedirectHops,
        isRedirector: isShortRedirectorHost,
        signal: opts.signal,
      });
      if (followed.url !== current) {
        unwrapped.push(...followed.hops);
        current = parseHttp(followed.url).href;
        peel();
      }
    }
  }
  if (opts.stripTracking) current = stripTrackingParams(current);

  const host = new URL(current).hostname.toLowerCase();
  for (const d of opts.destinationDenylist) {
    if (hostMatches(host, d)) {
      throw new AppError('DESTINATION_NOT_ALLOWED', { detail: `The destination host ${host} is deny-listed` });
    }
  }
  return { url: current, unwrapped };
}
