/**
 * Composition root: wires configuration, security, browser, queue, service and
 * HTTP layers together. Used by the entry point and by the test-suite (which
 * injects a DNS resolver and a test logger).
 */
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import type { BrowserType } from 'playwright';
import type { AppConfig } from './config.ts';
import { Logger } from './logger.ts';
import { Metrics } from './metrics.ts';
import { UrlPolicy } from './security/urlPolicy.ts';
import { SafeResolver, type LookupAllFn } from './security/resolver.ts';
import { EgressProxy } from './security/egressProxy.ts';
import { BrowserManager } from './browser/browserManager.ts';
import { JobQueue } from './queue/jobQueue.ts';
import { buildRegistry, type ShortenerRegistry } from './shorteners/registry.ts';
import type { ShortenerModule } from './shorteners/types.ts';
import { createAdvisor } from './agent/aiAdvisor.ts';
import { createCaptchaSolver } from './agent/captchaSolver.ts';
import { SafeHttpClient } from './extraction/redirectFollower.ts';
import { ResolverService } from './service/resolverService.ts';
import { JobStore } from './service/jobStore.ts';
import { createServer, type ApiServer } from './api/server.ts';
import { settle, sleep, withTimeout } from './util.ts';

export interface AppOverrides {
  logger?: Logger;
  lookupAll?: LookupAllFn;
  aiFetch?: typeof fetch;
  captchaFetch?: typeof fetch;
  browserType?: BrowserType;
  extraModules?: ShortenerModule[];
  /** Launch the browser lazily on first use instead of at start-up. */
  lazyBrowser?: boolean;
}

export interface App {
  config: AppConfig;
  logger: Logger;
  server: ApiServer;
  service: ResolverService;
  browsers: BrowserManager;
  proxy: EgressProxy;
  queue: JobQueue;
  registry: ShortenerRegistry;
  policy: UrlPolicy;
  resolver: SafeResolver;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<App> {
  const logger = overrides.logger ?? new Logger({ level: config.logging.level, bindings: { service: 'adlinkfly-resolver' } });
  const metrics = new Metrics();
  const policy = new UrlPolicy({
    allowedPorts: config.network.allowedPorts,
    allowPrivateCidrs: config.network.allowPrivateCidrs,
    domainDenylist: config.network.domainDenylist,
  });
  if (config.network.allowPrivateCidrs.length > 0) {
    logger.warn('private network ranges are exempted from SSRF protection', { cidrs: config.network.allowPrivateCidrs });
  }
  if (config.auth.disabled) logger.warn('API authentication is DISABLED (AUTH_DISABLED=true); do not expose this instance publicly');

  const resolver = new SafeResolver({ policy, lookupAll: overrides.lookupAll, cacheTtlMs: config.network.dnsCacheTtlMs });
  const proxy = new EgressProxy({ resolver, policy, logger });
  await proxy.start();

  const browsers = new BrowserManager({
    browser: config.browser,
    agent: config.agent,
    proxy,
    policy,
    logger,
    browserType: overrides.browserType,
  });
  const registry = buildRegistry(config.shorteners, overrides.extraModules);
  const advisor = createAdvisor(config.ai, logger, overrides.aiFetch);
  const captchaSolver = createCaptchaSolver(config.captcha, logger, overrides.captchaFetch);
  if (captchaSolver.enabled) {
    logger.warn('automatic CAPTCHA solving is ENABLED; ensure this is permitted for the sites you resolve', {
      provider: config.captcha.provider,
      max_solves_per_job: config.captcha.maxSolvesPerJob,
    });
  }
  const httpClient = new SafeHttpClient({ resolver, policy, userAgent: config.browser.userAgent });
  const queue = new JobQueue({
    concurrency: config.queue.concurrency,
    maxSize: config.queue.maxSize,
    queueTimeoutMs: config.queue.queueTimeoutMs,
  });
  const service = new ResolverService({
    config,
    policy,
    resolver,
    registry,
    browsers,
    queue,
    advisor,
    captchaSolver,
    httpClient,
    logger,
    metrics,
  });
  const jobs = new JobStore(config.queue.maxAsyncJobs, config.queue.asyncJobTtlMs);

  metrics.gauge('resolver_queue_active_jobs', 'Jobs currently running', () => queue.stats().active);
  metrics.gauge('resolver_queue_waiting_jobs', 'Jobs waiting in the queue', () => queue.stats().queued);
  metrics.gauge('resolver_browser_contexts_active', 'Open browser contexts', () => browsers.status().activeContexts);
  metrics.gauge('resolver_browser_launches_total', 'Browser launches', () => browsers.stats.launches);
  metrics.gauge('resolver_browser_crashes_total', 'Unexpected browser disconnects', () => browsers.stats.crashes);
  metrics.gauge('resolver_egress_blocked_total', 'Requests blocked by the egress proxy', () => proxy.stats.blocked);
  metrics.gauge('resolver_result_cache_entries', 'Entries in the result cache', () => service.cacheSize);

  let shuttingDown = false;
  const server = createServer({
    config,
    service,
    jobs,
    registry,
    metrics,
    logger,
    version: readVersion(),
    readiness: () => {
      const b = browsers.status();
      const q = queue.stats();
      const saturated = q.maxSize > 0 && q.queued >= q.maxSize;
      const browserOk = b.connected || overrides.lazyBrowser === true || b.stats.launches === 0;
      return {
        ready: !shuttingDown && browserOk && !saturated,
        details: {
          shutting_down: shuttingDown,
          browser: { connected: b.connected, generation: b.generation, active_contexts: b.activeContexts, ...b.stats },
          queue: q,
        },
      };
    },
  });

  const housekeeping = setInterval(() => service.pruneCache(), 60_000);
  housekeeping.unref();

  return {
    config,
    logger,
    server,
    service,
    browsers,
    proxy,
    queue,
    registry,
    policy,
    resolver,
    async listen() {
      if (!overrides.lazyBrowser) await browsers.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address() as AddressInfo;
      logger.info('server listening', { host: addr.address, port: addr.port, modules: registry.list().map((m) => m.id) });
      return addr;
    },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', { active: queue.stats().active, queued: queue.stats().queued });
      clearInterval(housekeeping);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      queue.close();
      const graceEnd = Date.now() + config.server.shutdownGraceMs;
      await settle(withTimeout(queue.onIdle(), config.server.shutdownGraceMs));
      // Let responses of finished jobs reach their clients before dropping connections.
      while (server.inflightRequests() > 0 && Date.now() < graceEnd) await sleep(50);
      server.closeAllConnections();
      await settle(withTimeout(closed, 5_000));
      await browsers.stop();
      await proxy.stop();
      logger.info('shutdown complete');
    },
  };
}
