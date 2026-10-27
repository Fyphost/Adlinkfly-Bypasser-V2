/**
 * Owns the Chromium process(es) and hands out isolated, hardened browser
 * contexts (one per resolution job).
 *
 * - A single browser process is shared; every job gets a fresh incognito
 *   context (own cookies/storage) that is destroyed afterwards.
 * - All context traffic is forced through the egress proxy with per-job
 *   credentials; the browser-level proxy has no credentials, so anything not
 *   attributed to a job fails closed.
 * - Crashed browsers are detected and relaunched lazily; browsers are recycled
 *   after a configurable number of jobs to bound memory growth.
 */
import type { Browser, BrowserContext, BrowserType, Route, Request } from 'playwright';
import { chromium } from 'playwright';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { AppError } from '../errors.ts';
import type { EgressProxy, EgressSession } from '../security/egressProxy.ts';
import type { UrlPolicy } from '../security/urlPolicy.ts';
import { isAdHost } from './adDomains.ts';
import { settle, withTimeout } from '../util.ts';

export interface JobContext {
  readonly context: BrowserContext;
  readonly session: EgressSession;
  readonly generation: number;
  /** Requests blocked by the in-browser route guard (policy, resource type, ads). */
  readonly routeStats: { blockedPolicy: number; blockedResource: number; total: number };
  isBrowserConnected(): boolean;
  release(): Promise<void>;
}

interface BrowserSlot {
  browser: Browser;
  generation: number;
  jobsServed: number;
  active: number;
  retiring: boolean;
  closing: boolean;
}

export interface BrowserManagerOptions {
  browser: AppConfig['browser'];
  agent: AppConfig['agent'];
  proxy: EgressProxy;
  policy: UrlPolicy;
  logger: Logger;
  browserType?: BrowserType;
}

const HARDENING_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-quic',
  '--dns-prefetch-disable',
  '--no-pings',
  '--mute-audio',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
];

export class BrowserManager {
  private readonly cfg: AppConfig['browser'];
  private readonly agentCfg: AppConfig['agent'];
  private readonly proxy: EgressProxy;
  private readonly policy: UrlPolicy;
  private readonly logger: Logger;
  private readonly browserType: BrowserType;
  private current: BrowserSlot | null = null;
  private launching: Promise<BrowserSlot> | null = null;
  private readonly slots = new Set<BrowserSlot>();
  private generation = 0;
  private stopped = false;
  readonly stats = { launches: 0, crashes: 0, contexts: 0, launchFailures: 0 };

  constructor(options: BrowserManagerOptions) {
    this.cfg = options.browser;
    this.agentCfg = options.agent;
    this.proxy = options.proxy;
    this.policy = options.policy;
    this.logger = options.logger.child({ component: 'browser' });
    this.browserType = options.browserType ?? chromium;
  }

  /** Eagerly launches the browser so the first request does not pay the start-up cost. */
  async start(): Promise<void> {
    await this.getSlot();
  }

  status(): { connected: boolean; generation: number; activeContexts: number; stats: BrowserManager['stats'] } {
    const active = [...this.slots].reduce((n, s) => n + s.active, 0);
    return {
      connected: !!this.current && this.current.browser.isConnected(),
      generation: this.current?.generation ?? 0,
      activeContexts: active,
      stats: this.stats,
    };
  }

  private async launch(): Promise<BrowserSlot> {
    const generation = ++this.generation;
    const started = Date.now();
    try {
      const browser = await this.browserType.launch({
        headless: this.cfg.headless,
        executablePath: this.cfg.executablePath,
        chromiumSandbox: this.cfg.sandbox,
        timeout: this.cfg.launchTimeoutMs,
        // Browser-level proxy has no credentials: traffic that is not bound to a job context fails closed.
        proxy: { server: this.proxy.url },
        args: [...HARDENING_ARGS, ...this.cfg.extraArgs],
        // Keep Chromium's built-in popup blocker enabled (Playwright disables it by default).
        ignoreDefaultArgs: ['--disable-popup-blocking'],
        // The application owns the lifecycle: running jobs may finish during graceful shutdown.
        // (Playwright still kills the browser if the Node process exits.)
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      const slot: BrowserSlot = { browser, generation, jobsServed: 0, active: 0, retiring: false, closing: false };
      this.slots.add(slot);
      this.stats.launches++;
      browser.on('disconnected', () => {
        this.slots.delete(slot);
        if (this.current === slot) this.current = null;
        if (!slot.closing && !this.stopped) {
          this.stats.crashes++;
          this.logger.error('browser disconnected unexpectedly', { generation, activeContexts: slot.active });
        }
      });
      this.logger.info('browser launched', { generation, version: browser.version(), ms: Date.now() - started });
      return slot;
    } catch (err) {
      this.stats.launchFailures++;
      this.logger.error('browser launch failed', { generation, error: (err as Error).message });
      throw new AppError('BROWSER_ERROR', { detail: 'The browser engine could not be started', cause: err, retryable: true });
    }
  }

  private async getSlot(): Promise<BrowserSlot> {
    if (this.stopped) throw new AppError('SHUTTING_DOWN');
    const cur = this.current;
    if (cur && cur.browser.isConnected() && !cur.retiring) {
      if (cur.jobsServed < this.cfg.recycleAfterJobs) return cur;
      this.retire(cur);
    }
    if (!this.launching) {
      this.launching = this.launch()
        .then((slot) => {
          if (this.stopped) {
            void this.closeSlot(slot);
            throw new AppError('SHUTTING_DOWN');
          }
          this.current = slot;
          return slot;
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  private retire(slot: BrowserSlot): void {
    slot.retiring = true;
    if (this.current === slot) this.current = null;
    this.logger.info('recycling browser', { generation: slot.generation, jobsServed: slot.jobsServed });
    if (slot.active === 0) void this.closeSlot(slot);
  }

  private async closeSlot(slot: BrowserSlot): Promise<void> {
    if (slot.closing) return;
    slot.closing = true;
    this.slots.delete(slot);
    await settle(withTimeout(slot.browser.close(), 15_000));
  }

  /** Creates an isolated, hardened context bound to a fresh egress session. */
  async newJobContext(): Promise<JobContext> {
    const slot = await this.getSlot();
    slot.jobsServed++;
    slot.active++;
    this.stats.contexts++;
    const session = this.proxy.createSession({
      maxBytes: this.agentCfg.maxBytesPerJob,
      maxRequests: this.agentCfg.maxRequestsPerJob,
    });
    let context: BrowserContext;
    try {
      context = await slot.browser.newContext({
        proxy: { server: this.proxy.url, username: session.username, password: session.password },
        acceptDownloads: false,
        serviceWorkers: 'block',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        userAgent: this.cfg.userAgent,
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        permissions: [],
      });
    } catch (err) {
      this.proxy.closeSession(session);
      slot.active--;
      throw new AppError('BROWSER_ERROR', { detail: 'Could not create a browser context', cause: err, retryable: true });
    }
    context.setDefaultTimeout(this.agentCfg.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.agentCfg.navigationTimeoutMs);

    const routeStats = { blockedPolicy: 0, blockedResource: 0, total: 0 };
    const blockTypes = new Set(this.cfg.blockResourceTypes);
    const blockAds = this.cfg.blockAdDomains;
    await context.route('**/*', async (route: Route, request: Request) => {
      routeStats.total++;
      const url = request.url();
      try {
        if (url.startsWith('http:') || url.startsWith('https:')) {
          const verdict = this.policy.checkNetworkUrl(url);
          if (!verdict.allowed) {
            routeStats.blockedPolicy++;
            let host = '';
            let port = 0;
            try {
              const u = new URL(url);
              host = u.hostname.replace(/^\[|\]$/g, '');
              port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
            } catch {
              /* ignore */
            }
            session.record({ kind: 'policy', host, port, reason: verdict.reason });
            await route.abort('blockedbyclient');
            return;
          }
          if (blockTypes.has(request.resourceType()) && !request.isNavigationRequest()) {
            routeStats.blockedResource++;
            await route.abort('blockedbyclient');
            return;
          }
          if (blockAds && !request.isNavigationRequest() && isAdHost(new URL(url).hostname)) {
            routeStats.blockedResource++;
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      } catch {
        // Context/page closed while routing — nothing to do.
      }
    });

    // Idempotent: concurrent callers (abort handler + finally block) share the same teardown.
    let releasing: Promise<void> | null = null;
    const release = (): Promise<void> => {
      releasing ??= (async () => {
        // Cut network access first so a hung page cannot keep talking while the context closes.
        this.proxy.closeSession(session);
        await settle(withTimeout(context.close(), 10_000));
        slot.active--;
        if ((slot.retiring || !slot.browser.isConnected()) && slot.active <= 0) await this.closeSlot(slot);
      })();
      return releasing;
    };

    return {
      context,
      session,
      generation: slot.generation,
      routeStats,
      isBrowserConnected: () => slot.browser.isConnected(),
      release,
    };
  }

  /**
   * Test hook: kills the current browser process with SIGKILL (simulating an
   * OOM kill / crash) and resolves once the disconnect has been observed.
   */
  async crashForTesting(): Promise<void> {
    const slot = this.current;
    if (!slot) return;
    const disconnected = new Promise<void>((resolve) => slot.browser.once('disconnected', () => resolve()));
    const cdp = await slot.browser.newBrowserCDPSession();
    const info = (await settle(withTimeout(cdp.send('SystemInfo.getProcessInfo'), 5_000))) as
      { processInfo?: Array<{ type: string; id: number }> } | undefined;
    const pid = info?.processInfo?.find((p) => p.type === 'browser')?.id;
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    } else {
      void cdp.send('Browser.crash' as never).catch(() => undefined);
    }
    await settle(withTimeout(disconnected, 20_000));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const pending = this.launching;
    if (pending) await settle(pending);
    await Promise.all([...this.slots].map((s) => this.closeSlot(s)));
    this.current = null;
  }
}
