/**
 * The resolution agent: an observe → decide → act loop driving one browser
 * context through a shortener flow.
 *
 * Each step it
 *   1. checks network evidence (platform API responses, downloads),
 *   2. observes the page (DOM probe over the main frame and same-flow frames),
 *   3. lets the shortener module recognise known page states,
 *   4. stops on human-verification challenges and error/expired pages,
 *   5. decides whether the page is still part of the flow or the destination,
 *   6. waits for countdowns / disabled buttons, or clicks the best candidate,
 *   7. falls back to meta-refresh, scrolling, idle waits and finally the AI advisor.
 * Popups are adopted when they continue the flow and closed otherwise.
 */
import type { BrowserContext, Download, Frame, Page, Request, Response } from 'playwright';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import { AppError, isAppError, type ErrorCode } from '../errors.ts';
import type { Logger } from '../logger.ts';
import type { JobContext } from '../browser/browserManager.ts';
import type { UrlPolicy } from '../security/urlPolicy.ts';
import type { ModuleContext, ModuleDecision, ShortenerModule } from '../shorteners/types.ts';
import { ShortenerRegistry } from '../shorteners/registry.ts';
import { AbortedError, settle, sleep, truncate, withTimeout } from '../util.ts';
import { pageProbe, waitProbe, type ProbeOptions } from './pageProbe.ts';
import type { AgentAction, PageSnapshot, ProbeResult, ScoredCandidate, TraceStep } from './types.ts';
import {
  ACTIONABLE_THRESHOLD,
  STRONG_THRESHOLD,
  candidateLabel,
  candidateSignature,
  hostOf,
  isHumanAttestation,
  scoreCandidate,
} from './scoring.ts';
import { INTERMEDIATE_THRESHOLD, assessChallenge, detectErrorPage, intermediateScore, looksLoading } from './classifier.ts';
import { isAdHost } from '../browser/adDomains.ts';
import type { AiAdvisor, AiAdvisorInput } from './aiAdvisor.ts';
import type { CaptchaKind, CaptchaSolver, CaptchaTask } from './captchaSolver.ts';
import type { ChallengeAssessment } from './classifier.ts';

export interface DestinationEvidence {
  url: string;
  confidence: number;
  source: string;
  at: number;
}

export interface AgentResult {
  destinationUrl: string;
  source: string;
  confidence: number;
  steps: number;
  trace: TraceStep[];
  visitedHosts: string[];
  /** Hosts identified as intermediate pages of the flow (excluding the shortener itself). */
  flowHosts: string[];
}

export interface AgentOptions {
  job: JobContext;
  module: ShortenerModule;
  agent: AppConfig['agent'];
  policy: UrlPolicy;
  advisor: AiAdvisor;
  logger: Logger;
  signal: AbortSignal;
  /** Maximum advisor calls for the whole job (shared across chained resolutions). */
  aiMaxCalls: number;
  aiCallsUsed?: { count: number };
  /** Optional CAPTCHA-solving tool (disabled no-op by default). */
  solver: CaptchaSolver;
  /** Maximum CAPTCHA solves for the whole job (shared across chained resolutions). */
  captchaMaxSolves: number;
  captchaSolvesUsed?: { count: number };
}

const MAX_TRACE = 120;

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return a === b;
  }
}

function withoutHash(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return u;
  }
}

function isHttpUrl(u: string | null | undefined): u is string {
  return !!u && /^https?:\/\//i.test(u);
}

export class ResolutionAgent {
  private readonly job: JobContext;
  private readonly context: BrowserContext;
  private readonly module: ShortenerModule;
  private readonly cfg: AppConfig['agent'];
  private readonly policy: UrlPolicy;
  private readonly advisor: AiAdvisor;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;
  private readonly attr = `data-agent-${randomBytes(3).toString('hex')}`;
  private readonly maxSteps: number;
  private readonly maxCountdownWaitMs: number;
  private readonly aiCalls: { count: number };
  private readonly aiMaxCalls: number;
  private readonly solver: CaptchaSolver;
  private readonly captchaSolves: { count: number };
  private readonly captchaMaxSolves: number;
  /** Page URLs where a CAPTCHA token was already injected (so the flow proceeds instead of re-solving). */
  private readonly captchaSolvedUrls = new Set<string>();

  private page!: Page;
  private navStartedAt = 0;
  private egressBlockedMain: { url: string; at: number } | null = null;
  private startUrl!: URL;
  private startedAt = 0;
  private step = 0;
  private readonly trace: TraceStep[] = [];
  private readonly evidence: DestinationEvidence[] = [];
  private readonly attempts = new Map<string, number>();
  private readonly flowHosts = new Set<string>();
  private readonly arrivals = new Map<string, number>();
  private readonly waitedOnUrl = new Map<string, number>();
  private readonly idleWaitsOnUrl = new Map<string, number>();
  private readonly scrolledUrls = new Map<string, number>();
  private readonly weakTried = new Set<string>();
  private readonly patientUrls = new Set<string>();
  /** Platform API endpoints learned from the page itself (e.g. a renamed AdLinkFly /links/go). */
  private readonly learnedApiUrls = new Set<string>();
  private lastFlowUrl: string | null = null;
  private wrongTurns = 0;
  /** Countdown readings of the previous observation of each URL (to confirm a timer is ticking). */
  private readonly lastReadings = new Map<string, Map<string, number>>();
  private readonly stalledCountdownUrls = new Set<string>();
  private readonly dialogs: string[] = [];
  private readonly platformMessages: string[] = [];
  private readonly visitedHosts = new Set<string>();
  private countdownWaitUsed = 0;
  private challengeWaitUsed = 0;
  private lastMainStatus: number | null = null;
  private lastNavFailure: { url: string; error: string } | null = null;
  private lastUrl = '';
  private lastSignature = '';
  private stagnantSteps = 0;
  private pageCrashed = false;
  private expectedPopup: { href: string | null; until: number; strong: boolean } | null = null;
  private pageSwitchWaiters: Array<() => void> = [];
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(options: AgentOptions) {
    this.job = options.job;
    this.context = options.job.context;
    this.module = options.module;
    this.cfg = options.agent;
    this.policy = options.policy;
    this.advisor = options.advisor;
    this.logger = options.logger;
    this.signal = options.signal;
    this.maxSteps = options.module.limits?.maxSteps ?? options.agent.maxSteps;
    this.maxCountdownWaitMs = options.module.limits?.maxCountdownWaitMs ?? options.agent.maxCountdownWaitMs;
    this.aiCalls = options.aiCallsUsed ?? { count: 0 };
    this.aiMaxCalls = options.aiMaxCalls;
    this.solver = options.solver;
    this.captchaSolves = options.captchaSolvesUsed ?? { count: 0 };
    this.captchaMaxSolves = options.captchaMaxSolves;
  }

  // ---------------------------------------------------------------- helpers

  private isShortenerHost(host: string): boolean {
    const h = host.toLowerCase();
    return (
      ShortenerRegistry.ownsHost(this.module, h) ||
      h === this.startUrl.hostname ||
      h === `www.${this.startUrl.hostname}` ||
      `www.${h}` === this.startUrl.hostname
    );
  }

  private isFlowHost(host: string): boolean {
    return this.isShortenerHost(host) || this.flowHosts.has(host.toLowerCase());
  }

  private moduleContext(): ModuleContext {
    return {
      startUrl: this.startUrl,
      step: this.step,
      elapsedMs: Date.now() - this.startedAt,
      isShortenerHost: (h) => this.isShortenerHost(h),
      isFlowHost: (h) => this.isFlowHost(h),
    };
  }

  private record(action: string, detail?: string, score?: number): void {
    let url = '';
    let title = '';
    try {
      url = this.page?.url() ?? '';
    } catch {
      /* ignore */
    }
    title = this.lastTitle;
    this.trace.push({
      step: this.step,
      url,
      title,
      action,
      detail: detail ? truncate(detail, 300) : undefined,
      score,
      at: Date.now() - this.startedAt,
    });
    if (this.trace.length > MAX_TRACE) this.trace.splice(1, 1);
    this.logger.debug('agent step', { step: this.step, action, detail, url });
  }

  private lastTitle = '';

  private abortReason(): AppError {
    const r: unknown = this.signal.reason;
    return isAppError(r) ? r : new AppError('CANCELLED');
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) throw this.abortReason();
  }

  private async wait(ms: number): Promise<void> {
    try {
      await sleep(ms, this.signal);
    } catch (err) {
      if (err instanceof AbortedError) throw this.abortReason();
      throw err;
    }
  }

  private fail(code: ErrorCode, detail: string, extra?: Record<string, unknown>): never {
    const messages = [...this.platformMessages, ...this.dialogs].slice(-3);
    throw new AppError(code, {
      detail,
      extra: {
        steps: this.step,
        last_url: this.safeUrl(),
        ...(messages.length ? { page_messages: messages.map((m) => truncate(m, 200)) } : {}),
        ...extra,
      },
    });
  }

  private safeUrl(): string | undefined {
    try {
      const u = this.page?.url();
      if (u && u.startsWith('http')) return u;
      return this.lastNavFailure?.url ?? this.startUrl?.href ?? u;
    } catch {
      return undefined;
    }
  }

  private addEvidence(e: Omit<DestinationEvidence, 'at'>): void {
    if (!isHttpUrl(e.url)) return;
    this.evidence.push({ ...e, at: Date.now() });
    this.logger.debug('destination evidence', { source: e.source, confidence: e.confidence });
  }

  private bestEvidence(min: number): DestinationEvidence | undefined {
    let best: DestinationEvidence | undefined;
    for (const e of this.evidence) if (e.confidence >= min && (!best || e.confidence > best.confidence)) best = e;
    return best;
  }

  // ------------------------------------------------------------ listeners

  private attachContext(): void {
    const onPage = (p: Page) => void this.onNewPage(p);
    const onResponse = (r: Response) => void this.onContextResponse(r);
    this.context.on('page', onPage);
    this.context.on('response', onResponse);
    this.listeners.push(() => this.context.off('page', onPage));
    this.listeners.push(() => this.context.off('response', onResponse));
  }

  private attachPage(p: Page): void {
    p.on('dialog', (d) => {
      this.dialogs.push(`${d.type()}: ${d.message()}`);
      if (this.dialogs.length > 20) this.dialogs.shift();
      void (d.type() === 'prompt' ? d.dismiss() : d.accept()).catch(() => undefined);
    });
    p.on('download', (d: Download) => {
      this.addEvidence({ url: d.url(), confidence: 0.9, source: 'download' });
      void d.cancel().catch(() => undefined);
    });
    p.on('crash', () => {
      if (p === this.page) this.pageCrashed = true;
    });
    p.on('response', (r: Response) => {
      if (p !== this.page) return;
      let isMain = false;
      try {
        isMain = r.request().isNavigationRequest() && r.frame() === p.mainFrame();
      } catch {
        isMain = false;
      }
      if (!isMain) return;
      const status = r.status();
      this.lastMainStatus = status;
      const headers = r.headers();
      if (headers['x-egress-blocked'] || headers['x-egress-error']) {
        this.egressBlockedMain = { url: r.url(), at: Date.now() };
        return;
      }
      if (status >= 200 && status < 300) {
        const ct = (r.headers()['content-type'] ?? '').toLowerCase();
        const host = hostOf(r.url());
        if (ct && !/html|xml|text\/plain/.test(ct) && host && !this.isFlowHost(host)) {
          this.addEvidence({ url: r.url(), confidence: 0.85, source: 'non_html_document' });
        }
      }
    });
    p.on('requestfailed', (req: Request) => {
      if (p !== this.page) return;
      try {
        if (req.isNavigationRequest() && req.frame() === p.mainFrame()) {
          this.lastNavFailure = { url: req.url(), error: req.failure()?.errorText ?? 'unknown' };
        }
      } catch {
        /* ignore */
      }
    });
  }

  private async onContextResponse(r: Response): Promise<void> {
    const patterns = this.module.hints?.apiPathPatterns ?? [];
    if (patterns.length === 0 && this.learnedApiUrls.size === 0) return;
    let req: Request;
    try {
      req = r.request();
    } catch {
      return;
    }
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    let u: URL;
    try {
      u = new URL(r.url());
    } catch {
      return;
    }
    if (!patterns.some((p) => p.test(u.pathname)) && !this.learnedApiUrls.has(`${u.origin}${u.pathname}`)) return;
    let body: string;
    try {
      body = await r.text();
    } catch {
      return;
    }
    if (body.length > 200_000) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return;
    }
    const data = (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>;
    const url = [json.url, json.destination, json.link, data.url].find((v) => typeof v === 'string' && isHttpUrl(v)) as string | undefined;
    if (!url) {
      if (typeof json.message === 'string' && json.message) this.platformMessages.push(`platform: ${json.message}`);
      return;
    }
    const host = hostOf(url);
    if (host && this.isFlowHost(host)) return; // next step inside the flow, the page will navigate there
    this.addEvidence({ url, confidence: 0.95, source: 'platform_api' });
  }

  private async onNewPage(p: Page): Promise<void> {
    if (this.disposed || p === this.page) return;
    this.attachPage(p);
    let url = p.url();
    if (!url || url === 'about:blank') {
      await settle(p.waitForURL((u) => u.href !== 'about:blank', { timeout: 4000, waitUntil: 'commit' }));
      url = p.url();
    }
    if (this.disposed) {
      await settle(p.close());
      return;
    }
    if (p === this.page) return; // already made the active page (e.g. by checkPageHealth) meanwhile
    const exp = this.expectedPopup;
    const live = !!exp && exp.until > Date.now();
    const host = hostOf(url);
    const matchesExpected = live && !!exp!.href && isHttpUrl(url) && sameDocument(exp!.href!, url);
    const intoFlow = live && !!host && this.isFlowHost(host);
    if (matchesExpected || intoFlow) {
      const old = this.page;
      this.expectedPopup = null; // one click adopts at most one pop-up
      this.page = p;
      this.lastMainStatus = null;
      this.record('adopt-popup', url);
      const waiters = this.pageSwitchWaiters;
      this.pageSwitchWaiters = [];
      waiters.forEach((w) => w());
      if (old && old !== p) await settle(old.close());
    } else {
      this.record('close-popup', host ?? url);
      await settle(p.close());
    }
  }

  // ------------------------------------------------------------- lifecycle

  async run(startUrl: URL): Promise<AgentResult> {
    this.startUrl = startUrl;
    this.startedAt = Date.now();
    this.throwIfAborted();
    try {
      this.page = await this.context.newPage();
      this.attachPage(this.page);
      this.attachContext();
      this.step = 0;
      this.record('navigate', startUrl.href);
      await this.navigate(startUrl.href, true);
      return await this.loop();
    } catch (err) {
      throw this.translateError(err);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    if (this.page) await settle(this.page.close());
  }

  getTrace(): TraceStep[] {
    return this.trace;
  }

  private translateError(err: unknown): AppError {
    if (this.signal.aborted) return this.abortReason();
    if (isAppError(err)) return err;
    if (err instanceof AbortedError) return this.abortReason();
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !this.job.isBrowserConnected() ||
      /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected/i.test(msg)
    ) {
      return new AppError('BROWSER_ERROR', {
        detail: 'The browser closed unexpectedly while processing the link',
        cause: err,
        retryable: true,
      });
    }
    this.logger.warn('unexpected agent error', { error: msg });
    return new AppError('INTERNAL_ERROR', { cause: err });
  }

  // ------------------------------------------------------------ navigation

  private async navigate(url: string, initial = false, referer?: string): Promise<void> {
    const verdict = this.policy.checkNetworkUrl(url);
    if (!verdict.allowed) {
      if (initial) throw new AppError('URL_NOT_ALLOWED', { detail: `The URL is not permitted: ${verdict.reason}` });
      this.fail('NAVIGATION_BLOCKED', `The flow attempted to open a forbidden address (${verdict.reason})`);
    }
    this.lastNavFailure = null;
    this.lastMainStatus = null;
    this.egressBlockedMain = null;
    this.navStartedAt = Date.now();
    const pageBefore = this.page;
    try {
      const resp = await pageBefore.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.navigationTimeoutMs, referer });
      if (resp && this.page === pageBefore) this.lastMainStatus = resp.status();
    } catch (err) {
      this.throwIfAborted();
      if (this.page !== pageBefore) return; // a pop-up carrying the flow was adopted meanwhile
      const msg = (err as Error).message ?? String(err);
      if (this.bestEvidence(0.85)) return; // e.g. the navigation turned into a download
      if ((err as Error).name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) {
        this.fail('NAVIGATION_TIMEOUT', `The page did not load within ${this.cfg.navigationTimeoutMs} ms`, { url });
      }
      if (/ERR_ABORTED|frame was detached|Navigation .* interrupted/i.test(msg) && !this.page.url().startsWith('chrome-error:')) {
        return; // superseded by another navigation (JS redirect) — the loop will observe the new page
      }
      if (!this.job.isBrowserConnected()) throw err;
      // lastNavFailure is updated asynchronously by the 'requestfailed' listener.
      const failure = this.lastNavFailure as { url: string; error: string } | null;
      const failed = failure?.url ?? url;
      this.failNavigation(failed, msg, initial);
    }
  }

  /** Maps a failed main-frame navigation to a meaningful error (policy block, DNS, TLS, timeout…). */
  private failNavigation(url: string, errorText: string, initial: boolean): never {
    let host = hostOf(url) ?? '';
    const since = this.navStartedAt - 50;
    // Only events that belong to this navigation: same host and recent, or a blocked *navigation*
    // request (route guard) — never an unrelated blocked sub-resource such as a tracker pixel.
    let ev = host ? this.job.session.lastEventFor(host) : undefined;
    if (ev && ev.at < since) ev = undefined;
    if (!ev) {
      const nav = [...this.job.session.events].reverse().find((e) => e.at >= since && e.navigation === true);
      if (nav) {
        ev = nav;
        host = nav.host;
      }
    }
    if (ev?.kind === 'policy' || (/ERR_BLOCKED_BY_CLIENT/.test(errorText) && ev)) {
      const reason = ev?.reason ?? 'blocked by egress policy';
      if (initial && host === this.startUrl.hostname)
        throw new AppError('URL_NOT_ALLOWED', { detail: `The URL is not permitted: ${reason}` });
      this.fail('NAVIGATION_BLOCKED', `The shortener redirected to a forbidden address (${host}: ${reason})`);
    }
    if (ev?.kind === 'limit') this.fail('NAVIGATION_FAILED', `The per-request resource budget was exceeded (${ev.reason})`);
    if (ev?.kind === 'dns' || /ERR_NAME_NOT_RESOLVED/.test(errorText)) {
      this.fail('NAVIGATION_FAILED', `The host ${host} could not be resolved`, { url });
    }
    if (/ERR_TOO_MANY_REDIRECTS/.test(errorText)) this.fail('REDIRECT_LOOP', 'The page redirected too many times');
    if (/TIMED_OUT|connect timeout/i.test(errorText) || ev?.reason === 'connect timeout') {
      this.fail('NAVIGATION_TIMEOUT', `Connecting to ${host} timed out`, { url });
    }
    if (/ERR_CERT|ERR_SSL/i.test(errorText)) this.fail('NAVIGATION_FAILED', `TLS/certificate error while loading ${host}`, { url });
    const short = /net::([A-Z_]+)/.exec(errorText)?.[1] ?? (ev?.reason ? `${ev.kind}: ${ev.reason}` : 'unknown error');
    this.fail('NAVIGATION_FAILED', `The page at ${host || url} could not be loaded (${short})`, { url });
  }

  private checkPageHealth(): void {
    if (this.pageCrashed) {
      throw new AppError('BROWSER_ERROR', { detail: 'The browser tab crashed while rendering the page', retryable: true });
    }
    if (this.page.isClosed()) {
      const open = this.context.pages().filter((p) => !p.isClosed());
      if (open.length > 0) {
        this.page = open[open.length - 1]!;
        this.record('switch-page', this.page.url());
        return;
      }
      if (!this.job.isBrowserConnected()) {
        throw new AppError('BROWSER_ERROR', { detail: 'The browser closed unexpectedly', retryable: true });
      }
      this.fail('UNEXPECTED_PAGE', 'The page was closed by the site');
    }
    const url = this.page.url();
    if (url.startsWith('chrome-error:')) {
      const f = this.lastNavFailure;
      this.failNavigation(f?.url ?? url, f?.error ?? 'net::ERR_FAILED', false);
    }
    const blocked = this.egressBlockedMain;
    if (blocked && sameDocument(blocked.url, url)) {
      this.failNavigation(blocked.url, 'egress', this.step <= 1);
    }
  }

  // ------------------------------------------------------------- observing

  private selectFrames(): Frame[] {
    const main = this.page.mainFrame();
    const mainHost = hostOf(main.url());
    const frames: Frame[] = [main];
    for (const f of this.page.frames()) {
      if (f === main || frames.length >= 6) continue;
      const h = hostOf(f.url());
      if (h && (h === mainHost || this.isFlowHost(h))) frames.push(f);
    }
    return frames;
  }

  private async observe(): Promise<PageSnapshot> {
    const opts: ProbeOptions = {
      attr: this.attr,
      maxCandidates: 150,
      textLimit: 6000,
      hintSelectors: this.module.hints?.preferredSelectors ?? [],
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.throwIfAborted();
      await settle(this.page.waitForLoadState('domcontentloaded', { timeout: this.cfg.navigationTimeoutMs }));
      this.checkPageHealth();
      const frames = this.selectFrames();
      const results = await Promise.all(
        frames.map((f) =>
          withTimeout(f.evaluate(pageProbe, opts), 10_000)
            .then((r: ProbeResult) => ({ f, r }))
            .catch((e: unknown) => {
              lastErr = e;
              return null;
            }),
        ),
      );
      const main = results[0];
      if (!main) {
        await this.wait(500);
        continue;
      }
      return this.buildSnapshot(
        main.r,
        results.filter((x): x is { f: Frame; r: ProbeResult } => !!x),
      );
    }
    this.checkPageHealth();
    this.fail('UNEXPECTED_PAGE', `The page could not be analysed (${truncate(String((lastErr as Error)?.message ?? lastErr), 120)})`);
  }

  private buildSnapshot(main: ProbeResult, all: Array<{ f: Frame; r: ProbeResult }>): PageSnapshot {
    const url = main.url;
    const scoringCtx = {
      pageUrl: url,
      isFlowHost: (h: string) => this.isFlowHost(h),
      attempts: new Map<string, number>(),
      hints: this.module.hints,
    };
    const pageKey = withoutHash(url);
    for (const [k, v] of this.attempts) if (k.startsWith(`${pageKey}::`)) scoringCtx.attempts.set(k.slice(pageKey.length + 2), v);
    const candidates: ScoredCandidate[] = [];
    for (const { f, r } of all) {
      for (const raw of r.candidates) {
        const { score, reasons } = scoreCandidate(raw, scoringCtx);
        candidates.push({
          ...raw,
          frame: f,
          frameUrl: r.url,
          score,
          reasons,
          signature: candidateSignature(raw),
          hrefHost: hostOf(raw.href),
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const challenge = { ...main.challenge };
    for (const { r } of all.slice(1)) {
      challenge.providers = [...new Set([...challenge.providers, ...r.challenge.providers])];
      challenge.visibleWidgets = [...new Set([...challenge.visibleWidgets, ...r.challenge.visibleWidgets])];
      challenge.invisibleBound ||= r.challenge.invisibleBound;
      challenge.scriptBound ||= r.challenge.scriptBound;
      challenge.captchaInputs += r.challenge.captchaInputs;
      challenge.captchaImages += r.challenge.captchaImages;
      challenge.textCues = [...new Set([...challenge.textCues, ...r.challenge.textCues])];
      challenge.sitekey ??= r.challenge.sitekey;
      challenge.captchaAction ??= r.challenge.captchaAction;
      challenge.captchaInvisible ||= r.challenge.captchaInvisible;
    }
    this.lastTitle = main.title;
    return {
      url,
      host: hostOf(url) ?? '',
      title: main.title,
      text: main.text,
      textLength: main.textLength,
      probe: main,
      candidates,
      countdowns: main.countdowns,
      challenge,
      markers: main.markers,
      status: this.lastMainStatus,
      takenAt: Date.now(),
    };
  }

  // ------------------------------------------------------------------ loop

  private async loop(): Promise<AgentResult> {
    for (this.step = 1; ; this.step++) {
      this.throwIfAborted();
      if (this.step > this.maxSteps) {
        this.fail('MAX_STEPS_EXCEEDED', `Maximum navigation attempts exceeded (${this.maxSteps} steps)`);
      }
      const ev = this.bestEvidence(0.85);
      if (ev) return this.done(ev);

      const snap = await this.observe();
      this.visitedHosts.add(snap.host);
      this.trackProgress(snap);
      if (snap.markers.goLinkAction && isHttpUrl(snap.markers.goLinkAction)) {
        const u = new URL(snap.markers.goLinkAction);
        this.learnedApiUrls.add(`${u.origin}${u.pathname}`);
      }

      const decision = this.module.decide?.(snap, this.moduleContext()) ?? null;
      if (decision?.type === 'destination') {
        this.record('platform-destination', decision.source);
        return this.done({ url: decision.url, confidence: decision.confidence, source: decision.source, at: Date.now() });
      }

      const challenge = assessChallenge(snap);
      if (challenge.blocking) {
        if (challenge.interstitial && this.challengeWaitUsed < this.cfg.challengeAutoWaitMs) {
          await this.waitForInterstitial(snap);
          continue;
        }
        const solvedKey = withoutHash(snap.url);
        if (this.captchaSolvedUrls.has(solvedKey)) {
          // A token was already injected for this page: fall through and let the normal flow
          // (countdown wait / clicking the now-unlocked button) continue instead of re-solving.
          this.record('captcha-proceed', 'token already injected; continuing the flow');
        } else if (await this.trySolveChallenge(snap, challenge)) {
          this.captchaSolvedUrls.add(solvedKey);
          continue;
        } else {
          this.record('human-verification', challenge.reason);
          this.fail('HUMAN_VERIFICATION_REQUIRED', `Human verification is required: ${challenge.reason}`, {
            verification_url: snap.url,
            challenge_type: challenge.type,
          });
        }
      }

      if (!isHttpUrl(snap.url)) {
        // Transitional document (about:blank, data:, …): give the navigation time to commit.
        this.record('wait', `non-http document (${truncate(snap.url, 40)})`);
        await this.wait(1000);
        continue;
      }

      const onShortener = this.isShortenerHost(snap.host);
      let knownFlow = onShortener || this.flowHosts.has(snap.host);
      if (!knownFlow) {
        if (isAdHost(snap.host)) {
          await this.recoverFromWrongTurn(snap);
          continue;
        }
        const inter = intermediateScore(snap, { isShortenerHost: (h) => this.isShortenerHost(h), isFlowHost: (h) => this.isFlowHost(h) });
        if (inter.score < INTERMEDIATE_THRESHOLD) {
          const verdict = await this.confirmDestination(snap, inter.score);
          if (verdict === 'destination') {
            this.record('landed-on-destination', inter.reasons.join(' '), inter.score);
            return this.done({ url: this.page.url(), confidence: 0.8, source: 'landing_page', at: Date.now() });
          }
          if (verdict === 'changed') continue;
          // The advisor says the flow continues here.
          this.flowHosts.add(snap.host);
          await this.execute(verdict, snap);
          continue;
        }
        this.flowHosts.add(snap.host);
        knownFlow = true;
        this.record('intermediate-page', `${snap.host}: ${inter.reasons.join(' ')}`, inter.score);
      }

      // Error / expired / wall detection only applies to pages of the shortener flow, never to the
      // destination site (whose own "not found" page is still the destination).
      if (knownFlow) {
        const errorPage = detectErrorPage(snap, {
          onShortenerHost: onShortener,
          startPath: this.startUrl.pathname,
          path: new URL(snap.url).pathname,
        });
        if (errorPage) {
          this.record('error-page', errorPage.detail);
          this.fail(errorPage.code, errorPage.detail);
        }
      }
      if (decision?.type === 'fail') this.fail(decision.code, decision.detail);
      this.lastFlowUrl = snap.url;

      const action =
        this.fromModuleDecision(decision, snap) ??
        this.countdownAction(snap) ??
        this.pickCandidate(snap) ??
        (await this.fallbackAction(snap));
      if (!action) {
        this.record('no-action');
        this.fail('NO_ACTION_FOUND', 'No actionable button or link could be identified on the page', {
          candidates_seen: snap.candidates.length,
        });
      }
      await this.execute(action, snap);
    }
  }

  private trackProgress(snap: PageSnapshot): void {
    const key = withoutHash(snap.url);
    if (key !== this.lastUrl) {
      const n = (this.arrivals.get(key) ?? 0) + 1;
      this.arrivals.set(key, n);
      this.lastUrl = key;
      this.stagnantSteps = 0;
      this.record('observe', `${snap.title || snap.host} (${snap.candidates.length} candidates)`);
      if (n > 4) this.fail('REDIRECT_LOOP', 'The flow keeps returning to the same page');
    }
    const sig = `${key}|${snap.candidates
      .slice(0, 8)
      .map((c) => `${c.signature}:${c.disabled ? 1 : 0}`)
      .join(',')}|${snap.countdowns.map((c) => c.value).join(',')}|${Math.round(snap.textLength / 50)}`;
    if (sig === this.lastSignature) this.stagnantSteps++;
    else this.stagnantSteps = 0;
    this.lastSignature = sig;
    if (this.stagnantSteps >= 8) this.fail('NO_ACTION_FOUND', 'The page did not react to any of the attempted actions');
  }

  /**
   * A click was hijacked (e.g. by an invisible ad overlay) and the tab landed on an ad network:
   * go back to the last page of the flow instead of mistaking the ad for the destination.
   */
  private async recoverFromWrongTurn(snap: PageSnapshot): Promise<void> {
    this.wrongTurns++;
    this.record('wrong-turn', `landed on advertising host ${snap.host}; returning to the flow`);
    if (this.wrongTurns > 4 || !this.lastFlowUrl) {
      this.fail('UNEXPECTED_PAGE', `The flow repeatedly led to advertising pages (${snap.host})`);
    }
    const back = await settle(this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.cfg.navigationTimeoutMs }));
    const here = this.page.url();
    if (!back || !isHttpUrl(here) || !this.isFlowHost(hostOf(here) ?? '')) {
      await this.navigate(this.lastFlowUrl, false);
    }
  }

  /** Decides whether a page outside the known flow is the destination. */
  private async confirmDestination(snap: PageSnapshot, score: number): Promise<'destination' | 'changed' | AgentAction> {
    const before = this.page.url();
    await settle(this.page.waitForLoadState('load', { timeout: 3000 }));
    await this.wait(1000);
    if (this.page.url() !== before || this.bestEvidence(0.85)) return 'changed';
    // Ambiguous page: ask the advisor (if configured) whether the flow continues here.
    if (score >= 3 && this.canUseAi()) {
      const decision = await this.askAi(
        snap,
        'Navigation reached a new website. Decide whether this is the final destination or still an intermediate page of the shortener flow.',
      );
      if (decision && typeof decision === 'object') return decision;
    }
    return 'destination';
  }

  private fromModuleDecision(decision: ModuleDecision | null, snap: PageSnapshot): AgentAction | null {
    if (!decision) return null;
    const key = withoutHash(snap.url);
    switch (decision.type) {
      case 'click': {
        const c = snap.candidates.find((x) => x.agentId === decision.agentId);
        if (!c || (this.attempts.get(`${key}::${c.signature}`) ?? 0) >= 3) return null;
        return { type: 'click', candidate: c, reason: decision.reason };
      }
      case 'goto':
        if ((this.arrivals.get(withoutHash(decision.url)) ?? 0) >= 3) return null;
        return { type: 'goto', url: decision.url, reason: decision.reason };
      case 'wait': {
        const waited = this.waitedOnUrl.get(key) ?? 0;
        if (waited >= decision.maxMs) return null;
        return {
          type: 'wait',
          ms: decision.maxMs - waited,
          reason: decision.reason,
          requiredMs: decision.requiredMs !== undefined ? Math.max(0, decision.requiredMs - waited) : undefined,
        };
      }
      default:
        return null;
    }
  }

  /**
   * A reading is trusted as a countdown when it carries a unit / wait context, or when it has been
   * seen decreasing. Bare numbers seen once (badges, counters) only earn a short verification wait,
   * so they can never exhaust the wait budget or fail the job.
   */
  private countdownAction(snap: PageSnapshot): AgentAction | null {
    const key = withoutHash(snap.url);
    const previous = this.lastReadings.get(key);
    this.lastReadings.set(key, new Map(snap.countdowns.map((c) => [c.key, c.value])));
    if (this.stalledCountdownUrls.has(key)) return null;
    const active = snap.countdowns.filter((c) => c.value > 0);
    if (active.length === 0) return null;
    const confirmed = active.filter((c) => c.hasUnit || (previous?.has(c.key) && previous.get(c.key)! > c.value));
    if (confirmed.length > 0) {
      const max = Math.max(...confirmed.map((c) => c.value));
      return { type: 'wait', ms: Math.min(max * 1000 + 1500, 120_000), reason: `countdown (${max}s)`, requiredMs: max * 1000 };
    }
    if (previous && active.every((c) => previous.get(c.key) === c.value)) return null; // static numbers: not a timer
    return { type: 'wait', ms: 2500, reason: 'possible countdown (verifying that it ticks)' };
  }

  private pickCandidate(snap: PageSnapshot): AgentAction | null {
    const key = withoutHash(snap.url);
    const actionable = snap.candidates
      .filter((c) => !c.disabled && c.score >= ACTIONABLE_THRESHOLD && !isHumanAttestation(candidateLabel(c)))
      .sort((a, b) => b.score - a.score || Number(a.obscured) - Number(b.obscured) || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    const best = actionable[0];
    if (!best) return null;
    const tries = this.attempts.get(`${key}::${best.signature}`) ?? 0;
    if (tries >= 2 && isHttpUrl(best.href) && !sameDocument(best.href, snap.url) && (this.arrivals.get(withoutHash(best.href)) ?? 0) < 3) {
      return {
        type: 'goto',
        url: best.href,
        reason: `follow "${truncate(candidateLabel(best), 40)}" directly after ${tries} click attempts`,
      };
    }
    return { type: 'click', candidate: best, reason: `best candidate "${truncate(candidateLabel(best), 50)}" [${best.reasons.join(' ')}]` };
  }

  private async fallbackAction(snap: PageSnapshot): Promise<AgentAction | null> {
    const key = withoutHash(snap.url);
    const meta = snap.probe.metaRefresh;
    if (meta?.url && !sameDocument(meta.url, snap.url)) {
      const waited = this.waitedOnUrl.get(key) ?? 0;
      const delayMs = Math.min(meta.delay, 60) * 1000 + 1000;
      if (waited < delayMs) return { type: 'wait', ms: delayMs - waited, reason: `meta refresh in ${meta.delay}s` };
      return { type: 'goto', url: meta.url, reason: 'meta refresh target' };
    }
    const disabledStrong = snap.candidates.filter((c) => c.disabled && c.score >= STRONG_THRESHOLD - 2);
    const waited = this.waitedOnUrl.get(key) ?? 0;
    if (disabledStrong.length > 0 && waited < 30_000) {
      return {
        type: 'wait',
        ms: Math.min(15_000, 30_000 - waited),
        reason: `waiting for "${truncate(candidateLabel(disabledStrong[0]!), 30)}" to become enabled`,
      };
    }
    // Many intermediate pages only reveal their button once the visitor scrolls: try that first.
    const scrolled = this.scrolledUrls.get(key) ?? 0;
    if (scrolled < 2 && snap.probe.scroll.height > snap.probe.scroll.viewport + 50) {
      this.scrolledUrls.set(key, scrolled + 1);
      return { type: 'scroll', reason: 'reveal content that appears on scroll' };
    }
    const idle = this.idleWaitsOnUrl.get(key) ?? 0;
    if ((snap.probe.hiddenStrongCandidates > 0 || looksLoading(snap)) && idle < 4) {
      this.idleWaitsOnUrl.set(key, idle + 1);
      return { type: 'wait', ms: 2500, reason: 'page appears to be loading or revealing its next step' };
    }
    if (!this.patientUrls.has(key)) {
      // Give late content (iframes, deferred scripts) one chance before concluding there is nothing to do.
      this.patientUrls.add(key);
      await settle(this.page.waitForLoadState('load', { timeout: 5000 }));
      return { type: 'wait', ms: 1500, reason: 'waiting for late-loading content' };
    }
    if (this.canUseAi()) {
      const d = await this.askAi(snap, 'The heuristics found no clear next action on this page.');
      if (d && typeof d === 'object') return d;
      if (d === 'destination' && !this.isShortenerHost(snap.host)) {
        this.addEvidence({ url: snap.url, confidence: 0.86, source: 'ai_destination' });
        return { type: 'wait', ms: 1, reason: 'advisor identified the destination' };
      }
    }
    // Last resort: a weak but plausible candidate inside the flow, tried once.
    const weak = snap.candidates.find(
      (c) =>
        !c.disabled &&
        c.score >= 3 &&
        !c.inAdContainer &&
        !this.weakTried.has(`${key}::${c.signature}`) &&
        !isHumanAttestation(candidateLabel(c)),
    );
    if (weak) {
      this.weakTried.add(`${key}::${weak.signature}`);
      return { type: 'click', candidate: weak, reason: `weak candidate "${truncate(candidateLabel(weak), 40)}" (score ${weak.score})` };
    }
    return null;
  }

  private canUseAi(): boolean {
    return this.advisor.enabled && this.aiCalls.count < this.aiMaxCalls;
  }

  /** Consults the AI advisor; returns an action, 'destination' or null. */
  private async askAi(snap: PageSnapshot, situation: string): Promise<AgentAction | 'destination' | null> {
    this.aiCalls.count++;
    const list = snap.candidates.slice(0, 25);
    const input: AiAdvisorInput = {
      url: snap.url,
      title: snap.title,
      step: this.step,
      situation,
      text: snap.text,
      countdowns: snap.countdowns.map((c) => c.value),
      candidates: list.map((c, index) => {
        let path: string | null = null;
        try {
          path = c.href ? truncate(new URL(c.href).pathname, 60) : null;
        } catch {
          path = null;
        }
        return {
          index,
          tag: c.tag,
          label: truncate(candidateLabel(c), 80),
          href_host: c.hrefHost,
          href_path: path,
          id: c.id,
          class: truncate(c.className, 60),
          disabled: c.disabled,
          heuristic_score: c.score,
        };
      }),
    };
    const d = await this.advisor.decide(input, this.signal);
    this.throwIfAborted();
    if (!d) return null;
    this.record('ai-decision', `${d.action}${'index' in d ? ` #${d.index}` : ''}: ${d.reason}`);
    switch (d.action) {
      case 'click': {
        const c = list[d.index]!;
        if (isHumanAttestation(candidateLabel(c))) return null; // never click human-verification controls
        return { type: 'click', candidate: c, reason: `advisor: ${d.reason}` };
      }
      case 'wait':
        return { type: 'wait', ms: d.seconds * 1000, reason: `advisor: ${d.reason}` };
      case 'scroll':
        return { type: 'scroll', reason: `advisor: ${d.reason}` };
      case 'destination':
        return 'destination';
      case 'blocked':
        return this.fail('HUMAN_VERIFICATION_REQUIRED', `Human verification is required (advisor: ${d.reason || 'challenge detected'})`, {
          verification_url: snap.url,
          challenge_type: 'detected_by_advisor',
        });
      default:
        return null;
    }
  }

  // --------------------------------------------------------------- acting

  private async execute(action: AgentAction, snap: PageSnapshot): Promise<void> {
    switch (action.type) {
      case 'click':
        this.record('click', action.reason, action.candidate.score);
        await this.click(action.candidate, snap);
        return;
      case 'goto':
        this.record('goto', `${action.reason}: ${action.url}`);
        await this.navigate(action.url, false, snap.url);
        return;
      case 'wait':
        this.record('wait', `${action.reason} (${Math.round(action.ms)} ms)`);
        await this.waitOnPage(action.ms, snap, action.reason, action.requiredMs ?? 0);
        return;
      case 'scroll':
        this.record('scroll', action.reason);
        await this.scroll();
        return;
    }
  }

  private async click(c: ScoredCandidate, snap: PageSnapshot): Promise<void> {
    const key = `${withoutHash(snap.url)}::${c.signature}`;
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    this.navStartedAt = Date.now();
    this.egressBlockedMain = null;
    const pageBefore = this.page;
    const urlBefore = this.page.url();
    this.expectedPopup = { href: isHttpUrl(c.href) ? c.href : null, until: Date.now() + 5000, strong: c.score >= STRONG_THRESHOLD };
    const switched = new Promise<void>((resolve) => this.pageSwitchWaiters.push(resolve));
    const loc = c.frame.locator(`[${this.attr}="${c.agentId}"]`).first();
    let clicked = false;
    try {
      await loc.click({ timeout: this.cfg.actionTimeoutMs, delay: 40 + Math.floor(Math.random() * 60) });
      clicked = true;
    } catch (err) {
      this.throwIfAborted();
      if (this.page !== pageBefore || this.page.url() !== urlBefore) {
        clicked = true;
      } else {
        this.logger.debug('click failed, retrying', { error: (err as Error).message.split('\n')[0] });
        try {
          await loc.click({ timeout: 1500, force: true });
          clicked = true;
        } catch {
          try {
            await loc.evaluate((el) => (el as HTMLElement).click());
            clicked = true;
          } catch {
            clicked = false;
          }
        }
      }
    }
    if (!clicked) this.record('click-failed', truncate(candidateLabel(c), 60));
    await this.settleAfterAction(pageBefore, urlBefore, switched);
  }

  private async settleAfterAction(pageBefore: Page, urlBefore: string, switched: Promise<void>): Promise<void> {
    const changed = pageBefore
      .waitForURL((u) => u.href !== urlBefore, { timeout: this.cfg.settleMs, waitUntil: 'commit' })
      .then(() => true)
      .catch(() => false);
    await Promise.race([changed, switched.then(() => true)]);
    this.throwIfAborted();
    if (this.page !== pageBefore || this.page.url() !== urlBefore) {
      await settle(this.page.waitForLoadState('domcontentloaded', { timeout: this.cfg.navigationTimeoutMs }));
      await this.wait(400);
    } else {
      await this.wait(300);
    }
  }

  private async scroll(): Promise<void> {
    const page = this.page;
    await settle(
      page.evaluate(async () => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        const max = document.documentElement.scrollHeight;
        for (let y = 0; y <= max; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      }),
    );
    await settle(page.mouse.wheel(0, 400));
    await this.wait(600);
  }

  private async waitOnPage(ms: number, snap: PageSnapshot, reason: string, requiredMs: number): Promise<void> {
    const key = withoutHash(snap.url);
    if (this.bestEvidence(0.85)) return; // the destination is already known
    const isCountdown = /countdown/i.test(reason);
    // Only waits the page itself demands (countdowns) draw on MAX_COUNTDOWN_WAIT_MS; other waits are
    // bounded per page and by the job deadline.
    const charged = isCountdown || requiredMs > 0;
    const remainingBudget = this.maxCountdownWaitMs - this.countdownWaitUsed;
    if (requiredMs > 0 && requiredMs > remainingBudget) {
      this.fail(
        'COUNTDOWN_TOO_LONG',
        `The page requires waiting longer than the configured maximum (${Math.round(this.maxCountdownWaitMs / 1000)} s)`,
      );
    }
    const budget = charged ? Math.min(ms, Math.max(remainingBudget, 0)) : ms;
    const watchIds = snap.candidates
      .filter((c) => c.disabled && c.score >= STRONG_THRESHOLD - 2)
      .map((c) => c.agentId)
      .slice(0, 10);
    const pageAtStart = this.page;
    const start = Date.now();
    let lastSig = '';
    let same = 0;
    let sawCountdown = false;
    let baselineStrong: number | null = null;
    let outcome = 'timeout';
    while (Date.now() - start < budget) {
      this.throwIfAborted();
      if (this.bestEvidence(0.85)) {
        outcome = 'evidence';
        break;
      }
      if (this.page !== pageAtStart) {
        outcome = 'page-switched';
        break;
      }
      await this.wait(Math.min(500, Math.max(1, budget - (Date.now() - start))));
      let p: Awaited<ReturnType<typeof waitProbe>> | null = null;
      try {
        p = await withTimeout(this.page.evaluate(waitProbe, { attr: this.attr, ids: watchIds }), 3000);
      } catch {
        if (this.page.isClosed() || withoutHash(this.page.url()) !== key) {
          outcome = 'navigated';
          break;
        }
        continue;
      }
      if (withoutHash(p.url) !== key) {
        outcome = 'navigated';
        break;
      }
      if (watchIds.length > 0 && p.enabled.length > 0) {
        outcome = 'enabled';
        break;
      }
      if (p.getLinkHref && isHttpUrl(p.getLinkHref) && p.getLinkDisabled === false) {
        outcome = 'link-released';
        break;
      }
      if (baselineStrong === null) baselineStrong = p.strongVisible;
      else if (p.strongVisible > baselineStrong) {
        outcome = 'new-action-revealed';
        await this.wait(300);
        break;
      }
      if (isCountdown) {
        const sig = p.countdown.join(',');
        if (sig === lastSig) same++;
        else {
          same = 0;
          lastSig = sig;
        }
        if (p.countdown.length > 0) sawCountdown = true;
        if ((p.countdown.length > 0 && p.countdown.every((v) => v <= 0)) || (sawCountdown && p.countdown.length === 0)) {
          outcome = 'countdown-finished';
          await this.wait(800);
          break;
        }
        if (p.countdown.length > 0 && same >= 5) {
          this.stalledCountdownUrls.add(key);
          outcome = 'countdown-stalled';
          break;
        }
      }
    }
    const spent = Date.now() - start;
    this.waitedOnUrl.set(key, (this.waitedOnUrl.get(key) ?? 0) + spent);
    if (charged) this.countdownWaitUsed += spent;
    if (outcome === 'timeout' && isCountdown) this.stalledCountdownUrls.add(key);
    this.record('wait-result', `${outcome} after ${spent} ms`);
  }

  private async waitForInterstitial(snap: PageSnapshot): Promise<void> {
    const budget = Math.min(this.cfg.challengeAutoWaitMs - this.challengeWaitUsed, 10_000);
    this.record('challenge-wait', 'browser challenge detected; waiting without interaction for it to clear on its own');
    const before = withoutHash(snap.url);
    const start = Date.now();
    while (Date.now() - start < budget) {
      await this.wait(500);
      if (this.page !== undefined && withoutHash(this.page.url()) !== before) break;
    }
    this.challengeWaitUsed += Date.now() - start;
    await settle(this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }));
  }

  // --------------------------------------------------------------- captcha

  /**
   * Optional CAPTCHA solving. When a solver is configured and the challenge is a
   * supported widget with a known site key, request a token, inject it, and let
   * the loop re-observe so the (now unlocked) flow button can be clicked. Returns
   * false on any miss so the caller falls back to HUMAN_VERIFICATION_REQUIRED.
   */
  private async trySolveChallenge(snap: PageSnapshot, challenge: ChallengeAssessment): Promise<boolean> {
    if (!this.solver.enabled || this.captchaSolves.count >= this.captchaMaxSolves) return false;
    const task = this.captchaTaskFromSnapshot(snap, challenge);
    if (!task) return false;
    this.captchaSolves.count++;
    this.record('captcha-solve-attempt', `${task.kind} (${challenge.reason})`);
    const solution = await this.solver.solve(task, this.signal);
    this.throwIfAborted();
    if (!solution) {
      this.record('captcha-solve-failed', task.kind);
      return false;
    }
    const injected = await this.injectCaptchaToken(solution.token);
    if (!injected) {
      this.record('captcha-inject-failed', task.kind);
      return false;
    }
    this.record('captcha-solved', task.kind);
    await this.wait(600);
    return true;
  }

  /** Builds a solver task from the challenge signals, or null when it is not solvable this way. */
  private captchaTaskFromSnapshot(snap: PageSnapshot, challenge: ChallengeAssessment): CaptchaTask | null {
    const c = snap.challenge;
    if (!c.sitekey || !isHttpUrl(snap.url)) return null;
    // Cloudflare's managed interstitial is handled by waiting, not by a site-key solve.
    if (challenge.type === 'cloudflare_challenge') return null;
    const providers = c.providers;
    let kind: CaptchaKind | null = null;
    if (providers.includes('hcaptcha')) kind = 'hcaptcha';
    else if (providers.includes('turnstile')) kind = 'turnstile';
    else if (providers.includes('recaptcha')) kind = c.captchaAction || c.captchaInvisible ? 'recaptcha-v3' : 'recaptcha-v2';
    if (!kind) return null;
    return {
      kind,
      sitekey: c.sitekey,
      pageUrl: snap.url,
      action: c.captchaAction,
      invisible: c.captchaInvisible,
    };
  }

  /**
   * Places the solved token into the standard response fields and invokes any
   * registered success callback, across the main frame and same-flow frames.
   */
  private async injectCaptchaToken(token: string): Promise<boolean> {
    let injected = false;
    for (const frame of this.selectFrames()) {
      try {
        const ok = await withTimeout(
          frame.evaluate((tok: string) => {
            let done = false;
            const names = ['g-recaptcha-response', 'h-captcha-response', 'cf-turnstile-response'];
            for (const name of names) {
              document.querySelectorAll(`textarea[name="${name}"], textarea#${name}`).forEach((el) => {
                const ta = el as HTMLTextAreaElement;
                ta.value = tok;
                (ta.style as CSSStyleDeclaration).display = '';
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                done = true;
              });
            }
            // Fire explicit data-callback handlers (invisible / bound widgets rely on these).
            document.querySelectorAll('[data-callback]').forEach((el) => {
              const name = el.getAttribute('data-callback');
              const fn = name ? (window as unknown as Record<string, unknown>)[name] : undefined;
              if (typeof fn === 'function') {
                try {
                  (fn as (t: string) => void)(tok);
                  done = true;
                } catch {
                  /* ignore a throwing site callback */
                }
              }
            });
            return done;
          }, token),
          5000,
        );
        injected = injected || ok === true;
      } catch {
        /* frame detached or evaluation failed: try the next frame */
      }
    }
    return injected;
  }

  // ------------------------------------------------------------------- done

  private done(e: DestinationEvidence): AgentResult {
    this.record('destination', `${e.source} (${e.confidence})`);
    return {
      destinationUrl: e.url,
      source: e.source,
      confidence: e.confidence,
      steps: this.step,
      trace: this.trace,
      visitedHosts: [...this.visitedHosts],
      flowHosts: [...this.flowHosts],
    };
  }
}
