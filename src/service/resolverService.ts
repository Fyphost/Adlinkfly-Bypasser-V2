/**
 * Orchestrates a resolution: validation → module matching → DNS/SSRF pre-check
 * → cache / in-flight de-duplication → queue → browser context → agent →
 * destination finalisation (unwrap, chained short links) → cache.
 */
import type { AppConfig } from '../config.ts';
import { AppError, isAppError, toAppError, describeError } from '../errors.ts';
import { formatUrlForLog, type Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { BrowserManager } from '../browser/browserManager.ts';
import type { JobQueue } from '../queue/jobQueue.ts';
import type { SafeResolver } from '../security/resolver.ts';
import { DnsResolutionError, EgressPolicyError } from '../security/resolver.ts';
import { urlCacheKey, type UrlPolicy } from '../security/urlPolicy.ts';
import { ShortenerRegistry } from '../shorteners/registry.ts';
import type { ShortenerModule } from '../shorteners/types.ts';
import { ResolutionAgent } from '../agent/agent.ts';
import type { AiAdvisor } from '../agent/aiAdvisor.ts';
import type { TraceStep } from '../agent/types.ts';
import { finalizeDestination } from '../extraction/destination.ts';
import type { SafeHttpClient } from '../extraction/redirectFollower.ts';
import { TtlCache } from './ttlCache.ts';

export interface ResolveOptions {
  requestId: string;
  noCache?: boolean;
  includeTrace?: boolean;
  signal?: AbortSignal;
  /** Invoked when the job leaves the queue and starts running (used by async jobs). */
  onStart?: () => void;
}

export interface ResolveSuccess {
  originalUrl: string;
  destinationUrl: string;
  shortener: string;
  source: string;
  steps: number;
  durationMs: number;
  cached: boolean;
  /** Short links that were followed when a shortener pointed to another supported shortener. */
  chain: string[];
  trace?: TraceStep[];
}

export interface ResolverServiceDeps {
  config: AppConfig;
  policy: UrlPolicy;
  resolver: SafeResolver;
  registry: ShortenerRegistry;
  browsers: BrowserManager;
  queue: JobQueue;
  advisor: AiAdvisor;
  httpClient: SafeHttpClient;
  logger: Logger;
  metrics: Metrics;
}

interface Inflight {
  promise: Promise<ResolveSuccess>;
  controller: AbortController;
  waiters: number;
}

export class ResolverService {
  private readonly d: ResolverServiceDeps;
  private readonly cache: TtlCache<ResolveSuccess>;
  private readonly inflight = new Map<string, Inflight>();
  private readonly logger: Logger;

  constructor(deps: ResolverServiceDeps) {
    this.d = deps;
    this.cache = new TtlCache<ResolveSuccess>(deps.config.cache.maxEntries, deps.config.cache.ttlMs);
    this.logger = deps.logger.child({ component: 'resolver' });
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  pruneCache(): void {
    this.cache.prune();
  }

  /** Validates the URL and finds the responsible module. Throws AppError. */
  async prepare(rawUrl: unknown): Promise<{ url: URL; module: ShortenerModule }> {
    const url = this.d.policy.parseSubmittedUrl(rawUrl);
    const module = this.d.registry.match(url);
    if (!module) {
      throw new AppError('UNSUPPORTED_SHORTENER', {
        detail: `The host ${url.hostname} is not a supported shortener`,
        extra: { supported: this.d.registry.list().flatMap((m) => m.domains) },
      });
    }
    try {
      await this.d.resolver.resolve(url.hostname);
    } catch (err) {
      if (err instanceof EgressPolicyError) throw new AppError('URL_NOT_ALLOWED', { detail: `The URL is not permitted: ${err.reason}` });
      if (err instanceof DnsResolutionError) {
        throw new AppError('NAVIGATION_FAILED', { detail: `The host ${url.hostname} could not be resolved (${err.code})` });
      }
      throw err;
    }
    return { url, module };
  }

  async resolve(rawUrl: unknown, opts: ResolveOptions): Promise<ResolveSuccess> {
    const started = Date.now();
    const log = this.logger.child({ request_id: opts.requestId });
    let shortener = 'unknown';
    try {
      const { url, module } = await this.prepare(rawUrl);
      shortener = module.id;
      const key = urlCacheKey(url);
      if (!opts.noCache && !opts.includeTrace) {
        const hit = this.cache.get(key);
        if (hit) {
          this.d.metrics.cacheHits.inc({ shortener });
          this.d.metrics.resolutions.inc({ shortener, outcome: 'resolved_cached' });
          log.info('resolution served from cache', { shortener, url: formatUrlForLog(url.href, this.d.config.logging.urlMode) });
          return { ...hit, cached: true, durationMs: Date.now() - started };
        }
      }
      const result = await this.runDeduplicated(key, url, module, opts, log);
      if (this.cache.enabled) this.cache.set(key, { ...result, trace: undefined });
      this.d.metrics.resolutions.inc({ shortener, outcome: 'resolved' });
      this.d.metrics.duration.observe((Date.now() - started) / 1000, { outcome: 'resolved' });
      log.info('resolution succeeded', {
        shortener,
        url: formatUrlForLog(url.href, this.d.config.logging.urlMode),
        destination: formatUrlForLog(result.destinationUrl, this.d.config.logging.urlMode),
        steps: result.steps,
        source: result.source,
        ms: Date.now() - started,
      });
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      const e = toAppError(err);
      this.d.metrics.resolutions.inc({ shortener, outcome: e.code });
      this.d.metrics.duration.observe((Date.now() - started) / 1000, { outcome: 'failed' });
      const level = e.httpStatus >= 500 && e.code !== 'QUEUE_FULL' ? 'warn' : 'info';
      log[level]('resolution failed', {
        shortener,
        code: e.code,
        detail: e.detail,
        ms: Date.now() - started,
        ...(e.code === 'INTERNAL_ERROR' ? { error: describeError(e.cause) } : {}),
      });
      throw e;
    }
  }

  /** Coalesces concurrent requests for the same URL into one job (unless a trace is requested). */
  private runDeduplicated(key: string, url: URL, module: ShortenerModule, opts: ResolveOptions, log: Logger): Promise<ResolveSuccess> {
    if (opts.includeTrace) return this.enqueue(url, module, opts.signal, true, log, opts.onStart);
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const starters: Array<() => void> = [];
      if (opts.onStart) starters.push(opts.onStart);
      const promise = this.enqueue(url, module, controller.signal, false, log, () => starters.forEach((s) => s())).finally(() => {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      entry = { promise, controller, waiters: 0 };
      this.inflight.set(key, entry);
    } else {
      log.debug('joined in-flight resolution', { shortener: module.id });
      opts.onStart?.();
    }
    const shared = entry;
    shared.waiters++;
    const signal = opts.signal;
    if (!signal) return shared.promise;
    if (signal.aborted) {
      shared.waiters--;
      if (shared.waiters === 0) shared.controller.abort(signal.reason);
      return Promise.reject(isAppError(signal.reason) ? signal.reason : new AppError('CANCELLED'));
    }
    return new Promise<ResolveSuccess>((resolve, reject) => {
      const onAbort = () => {
        shared.waiters--;
        // Only cancel the shared job when every interested client has gone away.
        if (shared.waiters === 0) shared.controller.abort(signal.reason);
        reject(isAppError(signal.reason) ? signal.reason : new AppError('CANCELLED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private enqueue(
    url: URL,
    module: ShortenerModule,
    signal: AbortSignal | undefined,
    includeTrace: boolean,
    log: Logger,
    onStart?: () => void,
  ): Promise<ResolveSuccess> {
    return this.d.queue.run(
      (jobSignal) => {
        onStart?.();
        return this.execute(url, module, jobSignal, includeTrace, log);
      },
      {
        timeoutMs: this.d.config.agent.jobTimeoutMs,
        signal,
      },
    );
  }

  private async execute(
    url: URL,
    module: ShortenerModule,
    signal: AbortSignal,
    includeTrace: boolean,
    log: Logger,
  ): Promise<ResolveSuccess> {
    const maxAttempts = this.d.config.agent.retryOnBrowserCrash ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw isAppError(signal.reason) ? signal.reason : new AppError('CANCELLED');
      const job = await this.d.browsers.newJobContext();
      // Make sure an aborted job tears its browser context down promptly.
      const onAbort = () => void job.release();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await this.runChain(job, url, module, signal, includeTrace, log);
      } catch (err) {
        const e = toAppError(err);
        if (e.code === 'BROWSER_ERROR' && e.retryable && attempt < maxAttempts && !signal.aborted) {
          log.warn('browser failure, retrying job once', { attempt, detail: e.detail });
          continue;
        }
        throw e;
      } finally {
        signal.removeEventListener('abort', onAbort);
        await job.release();
      }
    }
  }

  private async runChain(
    job: Awaited<ReturnType<BrowserManager['newJobContext']>>,
    startUrl: URL,
    startModule: ShortenerModule,
    signal: AbortSignal,
    includeTrace: boolean,
    log: Logger,
  ): Promise<ResolveSuccess> {
    const started = Date.now();
    const cfg = this.d.config;
    const aiCalls = { count: 0 };
    const chain: string[] = [];
    const trace: TraceStep[] = [];
    let current = startUrl;
    let module = startModule;
    let totalSteps = 0;
    for (let depth = 0; ; depth++) {
      const agent = new ResolutionAgent({
        job,
        module,
        agent: cfg.agent,
        policy: this.d.policy,
        advisor: this.d.advisor,
        logger: log.child({ shortener: module.id, depth }),
        signal,
        aiMaxCalls: cfg.ai.maxCallsPerJob,
        aiCallsUsed: aiCalls,
      });
      let result;
      try {
        result = await agent.run(current);
      } catch (err) {
        if (includeTrace && isAppError(err)) err.extra.trace = [...trace, ...agent.getTrace()];
        throw err;
      } finally {
        await agent.dispose();
      }
      totalSteps += result.steps;
      trace.push(...result.trace);
      const flowHosts = new Set([current.hostname, ...result.flowHosts]);
      const finalized = await finalizeDestination(result.destinationUrl, {
        stripTracking: cfg.extraction.stripTrackingParams,
        followTrackingRedirects: cfg.extraction.followTrackingRedirects,
        maxRedirectHops: cfg.extraction.maxRedirectHops,
        destinationDenylist: cfg.network.destinationDenylist,
        isFlowHost: (h) => flowHosts.has(h) || ShortenerRegistry.ownsHost(module, h),
        httpClient: this.d.httpClient,
      });
      const next = new URL(finalized.url);
      const nextModule = this.d.registry.isKnownShortenerHost(next.hostname) ? this.d.registry.match(next) : null;
      if (nextModule && depth < cfg.agent.maxChainDepth && finalized.url !== current.href) {
        log.info('destination is another supported short link, following chain', { shortener: nextModule.id, depth: depth + 1 });
        chain.push(finalized.url);
        current = next;
        module = nextModule;
        continue;
      }
      return {
        originalUrl: startUrl.href,
        destinationUrl: finalized.url,
        shortener: startModule.id,
        source: result.source,
        steps: totalSteps,
        durationMs: Date.now() - started,
        cached: false,
        chain,
        trace: includeTrace ? trace : undefined,
      };
    }
  }
}
