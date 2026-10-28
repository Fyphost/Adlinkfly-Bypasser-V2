/**
 * Optional CAPTCHA-solving tool.
 *
 * Off by default. When a shortener page is gated by a CAPTCHA that the agent
 * would otherwise report as HUMAN_VERIFICATION_REQUIRED, the agent can hand a
 * normalised task (provider, sitekey, page URL) to an external solving service
 * and inject the returned token so the flow can continue. Everything here is
 * provider-agnostic: the agent never learns which backend produced the token.
 *
 * Design mirrors the optional AiAdvisor (interface + disabled no-op + provider
 * client + create* factory, config-gated, with a per-job budget). All provider
 * I/O goes through an injectable fetch so it can be exercised in tests.
 *
 * NOTE on scope: solving CAPTCHAs may conflict with the terms of service of the
 * target sites and of the CAPTCHA providers. This capability ships disabled;
 * enable it only where you are authorised to do so. On any failure the solver
 * returns null and the agent falls back to its original "report and stop"
 * behaviour.
 */
import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

/** CAPTCHA families this tool can request a token for. */
export type CaptchaKind = 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile';

export interface CaptchaTask {
  kind: CaptchaKind;
  /** Public site key of the widget (data-sitekey / render() sitekey / data-pkey). */
  sitekey: string;
  /** URL of the page hosting the widget. */
  pageUrl: string;
  /** reCAPTCHA v3 action, when known. */
  action?: string;
  /** Hint that the widget is invisible / bound to an action control. */
  invisible?: boolean;
}

export interface CaptchaSolution {
  /** The token to place into g-recaptcha-response / h-captcha-response / cf-turnstile-response. */
  token: string;
}

export interface CaptchaSolver {
  readonly enabled: boolean;
  solve(task: CaptchaTask, signal?: AbortSignal): Promise<CaptchaSolution | null>;
}

export const disabledSolver: CaptchaSolver = {
  enabled: false,
  solve: async () => null,
};

type FetchFn = typeof fetch;

/** Providers that expose the Anti-Captcha-style JSON API (createTask / getTaskResult). */
type JsonProvider = 'capsolver' | '2captcha';

/** Provider-specific "proxyless" task type names. 2captcha's JSON API (api.2captcha.com) and
 * CapSolver both follow the Anti-Captcha spec but differ in casing / turnstile naming. */
const TASK_TYPES: Record<JsonProvider, Record<CaptchaKind, string>> = {
  capsolver: {
    'recaptcha-v2': 'ReCaptchaV2TaskProxyLess',
    'recaptcha-v3': 'ReCaptchaV3TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
    turnstile: 'AntiTurnstileTaskProxyLess',
  },
  '2captcha': {
    'recaptcha-v2': 'RecaptchaV2TaskProxyless',
    'recaptcha-v3': 'RecaptchaV3TaskProxyless',
    hcaptcha: 'HCaptchaTaskProxyless',
    turnstile: 'TurnstileTaskProxyless',
  },
};

function taskType(provider: JsonProvider, kind: CaptchaKind): string {
  return TASK_TYPES[provider][kind];
}

function buildTaskPayload(provider: JsonProvider, task: CaptchaTask): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: taskType(provider, task.kind),
    websiteURL: task.pageUrl,
    websiteKey: task.sitekey,
  };
  if (task.kind === 'recaptcha-v2' && task.invisible) payload.isInvisible = true;
  if (task.kind === 'recaptcha-v3') {
    if (task.action) payload.pageAction = task.action;
    payload.minScore = 0.3;
  }
  if (task.kind === 'turnstile' && task.action) {
    // capsolver takes the action under metadata; 2captcha accepts a top-level action.
    if (provider === 'capsolver') payload.metadata = { action: task.action };
    else payload.action = task.action;
  }
  return payload;
}

interface CreateTaskResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number | string;
}

interface TaskResultResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  solution?: { gRecaptchaResponse?: string; token?: string; text?: string };
}

/**
 * Client for the create-task / poll-result JSON APIs exposed by 2captcha
 * (api.2captcha.com) and CapSolver (api.capsolver.com), which share the
 * Anti-Captcha request/response shape.
 */
export class HttpCaptchaSolver implements CaptchaSolver {
  readonly enabled = true;
  private readonly cfg: AppConfig['captcha'];
  private readonly provider: JsonProvider;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchFn;

  constructor(cfg: AppConfig['captcha'], logger: Logger, fetchImpl: FetchFn = fetch) {
    this.cfg = cfg;
    this.provider = cfg.provider as JsonProvider;
    this.logger = logger.child({ component: 'captcha-solver', provider: cfg.provider });
    this.fetchImpl = fetchImpl;
  }

  async solve(task: CaptchaTask, signal?: AbortSignal): Promise<CaptchaSolution | null> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    try {
      const taskId = await this.createTask(task, combined);
      const token = await this.pollResult(taskId, combined);
      this.logger.info('captcha solve finished', { ms: Date.now() - started, kind: task.kind, solved: !!token });
      return token ? { token } : null;
    } catch (err) {
      this.logger.warn('captcha solve failed', { ms: Date.now() - started, kind: task.kind, error: (err as Error).message });
      return null;
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: this.cfg.apiKey, ...body }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async createTask(task: CaptchaTask, signal: AbortSignal): Promise<string> {
    const json = await this.post<CreateTaskResponse>('createTask', { task: buildTaskPayload(this.provider, task) }, signal);
    if (json.errorId) throw new Error(json.errorDescription || json.errorCode || `createTask errorId ${json.errorId}`);
    if (json.taskId === undefined || json.taskId === null || json.taskId === '') throw new Error('createTask returned no taskId');
    return String(json.taskId);
  }

  private async pollResult(taskId: string, signal: AbortSignal): Promise<string | null> {
    // One initial grace delay before the first poll; solving typically takes several seconds.
    await delay(this.cfg.pollIntervalMs, signal);
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const json = await this.post<TaskResultResponse>('getTaskResult', { taskId }, signal);
      if (json.errorId) throw new Error(json.errorDescription || json.errorCode || `getTaskResult errorId ${json.errorId}`);
      if (json.status === 'ready') {
        const token = json.solution?.gRecaptchaResponse ?? json.solution?.token ?? json.solution?.text ?? null;
        return token && token.length > 0 ? token : null;
      }
      await delay(this.cfg.pollIntervalMs, signal);
    }
  }
}

interface LegacyResponse {
  status?: number;
  request?: string;
}

/**
 * Client for the classic 2captcha `in.php` / `res.php` HTTP API (submit a task,
 * then poll for the token). This is the protocol exposed by CapSkip, a local
 * flat-rate solver that runs on the device / VPS (default http://127.0.0.1:8080),
 * and by legacy 2captcha-compatible endpoints. Requests use `json=1` so the
 * responses are parsed as JSON rather than the `OK|TOKEN` text form.
 */
export class LegacyCaptchaSolver implements CaptchaSolver {
  readonly enabled = true;
  private readonly cfg: AppConfig['captcha'];
  private readonly logger: Logger;
  private readonly fetchImpl: FetchFn;

  constructor(cfg: AppConfig['captcha'], logger: Logger, fetchImpl: FetchFn = fetch) {
    this.cfg = cfg;
    this.logger = logger.child({ component: 'captcha-solver', provider: cfg.provider });
    this.fetchImpl = fetchImpl;
  }

  async solve(task: CaptchaTask, signal?: AbortSignal): Promise<CaptchaSolution | null> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    try {
      const id = await this.submit(task, combined);
      const token = await this.poll(id, combined);
      this.logger.info('captcha solve finished', { ms: Date.now() - started, kind: task.kind, solved: !!token });
      return token ? { token } : null;
    } catch (err) {
      this.logger.warn('captcha solve failed', { ms: Date.now() - started, kind: task.kind, error: (err as Error).message });
      return null;
    }
  }

  private submitParams(task: CaptchaTask): URLSearchParams {
    const p = new URLSearchParams();
    p.set('key', this.cfg.apiKey ?? '');
    p.set('json', '1');
    p.set('pageurl', task.pageUrl);
    switch (task.kind) {
      case 'recaptcha-v2':
        p.set('method', 'userrecaptcha');
        p.set('googlekey', task.sitekey);
        if (task.invisible) p.set('invisible', '1');
        break;
      case 'recaptcha-v3':
        p.set('method', 'userrecaptcha');
        p.set('version', 'v3');
        p.set('googlekey', task.sitekey);
        if (task.action) p.set('action', task.action);
        p.set('min_score', '0.3');
        break;
      case 'hcaptcha':
        p.set('method', 'hcaptcha');
        p.set('sitekey', task.sitekey);
        break;
      case 'turnstile':
        p.set('method', 'turnstile');
        p.set('sitekey', task.sitekey);
        if (task.action) p.set('action', task.action);
        break;
    }
    return p;
  }

  private async submit(task: CaptchaTask, signal: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/in.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: this.submitParams(task).toString(),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as LegacyResponse;
    if (json.status !== 1 || !json.request) throw new Error(`in.php: ${json.request ?? 'unknown error'}`);
    return json.request;
  }

  private async poll(id: string, signal: AbortSignal): Promise<string | null> {
    await delay(this.cfg.pollIntervalMs, signal);
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const url = new URL(`${this.cfg.baseUrl}/res.php`);
      url.searchParams.set('key', this.cfg.apiKey ?? '');
      url.searchParams.set('action', 'get');
      url.searchParams.set('id', id);
      url.searchParams.set('json', '1');
      const res = await this.fetchImpl(url.toString(), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LegacyResponse;
      if (json.status === 1) return json.request && json.request.length > 0 ? json.request : null;
      if (json.request && json.request !== 'CAPCHA_NOT_READY') throw new Error(`res.php: ${json.request}`);
      await delay(this.cfg.pollIntervalMs, signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createCaptchaSolver(cfg: AppConfig['captcha'], logger: Logger, fetchImpl?: FetchFn): CaptchaSolver {
  if (cfg.provider === 'none' || cfg.maxSolvesPerJob === 0) return disabledSolver;
  // CapSkip (local, flat-rate) speaks the classic 2captcha in.php/res.php protocol.
  if (cfg.provider === 'capskip') return new LegacyCaptchaSolver(cfg, logger, fetchImpl);
  // capsolver / 2captcha use the Anti-Captcha-style JSON API.
  return new HttpCaptchaSolver(cfg, logger, fetchImpl);
}
