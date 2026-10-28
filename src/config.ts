/**
 * Environment-driven configuration. All settings are parsed and validated at
 * start-up; invalid configuration aborts the process with a list of problems
 * instead of failing later at request time.
 */
import { createHash } from 'node:crypto';
import type { LogLevel } from './logger.ts';
import { parseCidr } from './security/ip.ts';

export type UrlLogMode = 'full' | 'host' | 'none';
export type AiProvider = 'none' | 'openai' | 'anthropic';
export type CaptchaProvider = 'none' | '2captcha' | 'capsolver';

export interface ApiKeyEntry {
  /** Non-secret identifier used in logs and job ownership checks. */
  id: string;
  /** SHA-256 digest of the key. Plain keys are never kept in memory longer than needed. */
  sha256: Buffer;
}

export interface AppConfig {
  env: string;
  server: {
    host: string;
    port: number;
    maxBodyBytes: number;
    trustProxyHops: number;
    corsOrigins: string[];
    headersTimeoutMs: number;
    requestTimeoutMs: number;
    shutdownGraceMs: number;
    cancelOnClientDisconnect: boolean;
  };
  auth: { disabled: boolean; keys: ApiKeyEntry[] };
  rateLimit: { perMinute: number; burst: number; authFailuresPerMinute: number };
  logging: { level: LogLevel; urlMode: UrlLogMode };
  queue: {
    concurrency: number;
    maxSize: number;
    queueTimeoutMs: number;
    asyncJobTtlMs: number;
    maxAsyncJobs: number;
  };
  agent: {
    jobTimeoutMs: number;
    navigationTimeoutMs: number;
    actionTimeoutMs: number;
    maxSteps: number;
    maxCountdownWaitMs: number;
    challengeAutoWaitMs: number;
    maxChainDepth: number;
    maxRequestsPerJob: number;
    maxBytesPerJob: number;
    settleMs: number;
    retryOnBrowserCrash: boolean;
  };
  browser: {
    headless: boolean;
    executablePath: string | undefined;
    sandbox: boolean;
    recycleAfterJobs: number;
    launchTimeoutMs: number;
    userAgent: string | undefined;
    blockResourceTypes: string[];
    blockAdDomains: boolean;
    extraArgs: string[];
  };
  network: {
    allowedPorts: Set<number> | 'any';
    allowPrivateCidrs: string[];
    domainDenylist: string[];
    destinationDenylist: string[];
    dnsCacheTtlMs: number;
  };
  shorteners: { allowUnlisted: boolean; adlinkflyExtraDomains: string[]; disabledModules: string[] };
  extraction: { followTrackingRedirects: boolean; stripTrackingParams: boolean; maxRedirectHops: number };
  cache: { ttlMs: number; maxEntries: number };
  ai: {
    provider: AiProvider;
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxCallsPerJob: number;
    jsonMode: boolean;
  };
  captcha: {
    provider: CaptchaProvider;
    apiKey: string | undefined;
    baseUrl: string;
    timeoutMs: number;
    pollIntervalMs: number;
    maxSolvesPerJob: number;
  };
  metrics: { enabled: boolean; requireAuth: boolean };
}

function defaultCaptchaBaseUrl(provider: CaptchaProvider): string {
  switch (provider) {
    case 'capsolver':
      return 'https://api.capsolver.com';
    case '2captcha':
      return 'https://api.2captcha.com';
    default:
      return '';
  }
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

class EnvReader {
  readonly problems: string[] = [];
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  raw(name: string): string | undefined {
    const v = this.env[name];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  }

  str(name: string, def: string): string {
    return this.raw(name) ?? def;
  }

  optStr(name: string): string | undefined {
    return this.raw(name);
  }

  int(name: string, def: number, min: number, max: number): number {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (!/^-?\d+$/.test(v)) {
      this.problems.push(`${name} must be an integer (got "${v}")`);
      return def;
    }
    const n = Number(v);
    if (n < min || n > max) {
      this.problems.push(`${name} must be between ${min} and ${max} (got ${n})`);
      return def;
    }
    return n;
  }

  bool(name: string, def: boolean): boolean {
    const v = this.raw(name);
    if (v === undefined) return def;
    const l = v.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(l)) return true;
    if (['0', 'false', 'no', 'off'].includes(l)) return false;
    this.problems.push(`${name} must be a boolean (got "${v}")`);
    return def;
  }

  list(name: string, def: string[] = []): string[] {
    const v = this.raw(name);
    if (v === undefined) return def;
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  oneOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
    const v = this.raw(name);
    if (v === undefined) return def;
    const l = v.toLowerCase() as T;
    if (!allowed.includes(l)) {
      this.problems.push(`${name} must be one of ${allowed.join(', ')} (got "${v}")`);
      return def;
    }
    return l;
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseApiKeys(r: EnvReader): ApiKeyEntry[] {
  const keys: ApiKeyEntry[] = [];
  // API_KEYS: "label:key" or "key" entries.
  r.list('API_KEYS').forEach((entry, i) => {
    const idx = entry.indexOf(':');
    const label = idx > 0 ? entry.slice(0, idx) : `key${i + 1}`;
    const key = idx > 0 ? entry.slice(idx + 1) : entry;
    if (key.length < 16) {
      r.problems.push(`API_KEYS entry "${label}" is too short (minimum 16 characters)`);
      return;
    }
    keys.push({ id: label, sha256: sha256(key) });
  });
  // API_KEY_HASHES: "label:sha256hex" or "sha256hex" entries (preferred: no plaintext secrets in env).
  r.list('API_KEY_HASHES').forEach((entry, i) => {
    const idx = entry.indexOf(':');
    const label = idx > 0 ? entry.slice(0, idx) : `hash${i + 1}`;
    const hex = (idx > 0 ? entry.slice(idx + 1) : entry).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      r.problems.push(`API_KEY_HASHES entry "${label}" must be a 64 character SHA-256 hex digest`);
      return;
    }
    keys.push({ id: label, sha256: Buffer.from(hex, 'hex') });
  });
  const ids = new Set<string>();
  for (const k of keys) {
    if (ids.has(k.id)) r.problems.push(`Duplicate API key label "${k.id}"`);
    ids.add(k.id);
  }
  return keys;
}

function parsePorts(r: EnvReader): Set<number> | 'any' {
  const v = r.raw('ALLOWED_PORTS');
  if (v === undefined) return new Set([80, 443]);
  if (v.toLowerCase() === 'any') return 'any';
  const ports = new Set<number>();
  for (const p of v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      r.problems.push(`ALLOWED_PORTS contains an invalid port "${p}"`);
      continue;
    }
    ports.add(n);
  }
  if (ports.size === 0) r.problems.push('ALLOWED_PORTS must contain at least one port');
  return ports;
}

function normaliseDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^\*\./, '.').replace(/\.$/, '');
}

export function loadConfig(env: Env = process.env): AppConfig {
  const r = new EnvReader(env);
  const nodeEnv = r.str('NODE_ENV', 'production');

  const keys = parseApiKeys(r);
  const authDisabled = r.bool('AUTH_DISABLED', false);
  if (!authDisabled && keys.length === 0) {
    r.problems.push('No API keys configured: set API_KEYS or API_KEY_HASHES (or AUTH_DISABLED=true for local development only)');
  }

  const allowPrivateCidrs = r.list('ALLOW_PRIVATE_NETWORK_CIDRS');
  for (const c of allowPrivateCidrs) {
    if (!parseCidr(c)) r.problems.push(`ALLOW_PRIVATE_NETWORK_CIDRS contains an invalid CIDR "${c}"`);
  }

  const aiProvider = r.oneOf<AiProvider>('AI_PROVIDER', 'none', ['none', 'openai', 'anthropic']);
  const aiApiKey = r.optStr('AI_API_KEY');
  const aiBaseUrl = r.str('AI_BASE_URL', aiProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  const aiModel = r.str('AI_MODEL', '');
  if (aiProvider !== 'none') {
    if (!aiModel) r.problems.push('AI_MODEL is required when AI_PROVIDER is enabled');
    try {
      const u = new URL(aiBaseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      r.problems.push(`AI_BASE_URL is not a valid http(s) URL ("${aiBaseUrl}")`);
    }
  }

  const captchaProvider = r.oneOf<CaptchaProvider>('CAPTCHA_PROVIDER', 'none', ['none', '2captcha', 'capsolver']);
  const captchaApiKey = r.optStr('CAPTCHA_API_KEY');
  const captchaBaseUrl = r.str('CAPTCHA_BASE_URL', defaultCaptchaBaseUrl(captchaProvider));
  if (captchaProvider !== 'none') {
    try {
      const u = new URL(captchaBaseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      r.problems.push(`CAPTCHA_BASE_URL is not a valid http(s) URL ("${captchaBaseUrl}")`);
    }
  }

  const userAgent = r.optStr('USER_AGENT');
  const blockResourceTypes = r.list('BLOCK_RESOURCE_TYPES', ['media', 'font']).map((s) => s.toLowerCase());
  const validTypes = ['image', 'media', 'font', 'stylesheet', 'texttrack', 'eventsource', 'websocket', 'manifest', 'other'];
  for (const t of blockResourceTypes) {
    if (!validTypes.includes(t))
      r.problems.push(`BLOCK_RESOURCE_TYPES contains unsupported type "${t}" (allowed: ${validTypes.join(', ')})`);
  }

  const config: AppConfig = {
    env: nodeEnv,
    server: {
      host: r.str('HOST', '0.0.0.0'),
      port: r.int('PORT', 8080, 0, 65535),
      maxBodyBytes: r.int('MAX_BODY_BYTES', 16 * 1024, 256, 1024 * 1024),
      trustProxyHops: r.int('TRUST_PROXY_HOPS', 0, 0, 10),
      corsOrigins: r.list('CORS_ORIGINS'),
      headersTimeoutMs: r.int('HTTP_HEADERS_TIMEOUT_MS', 15_000, 1_000, 120_000),
      requestTimeoutMs: r.int('HTTP_REQUEST_TIMEOUT_MS', 30_000, 1_000, 300_000),
      shutdownGraceMs: r.int('SHUTDOWN_GRACE_MS', 30_000, 0, 600_000),
      cancelOnClientDisconnect: r.bool('CANCEL_ON_CLIENT_DISCONNECT', true),
    },
    auth: { disabled: authDisabled, keys },
    rateLimit: {
      perMinute: r.int('RATE_LIMIT_PER_MINUTE', 30, 1, 100_000),
      burst: r.int('RATE_LIMIT_BURST', 10, 1, 100_000),
      authFailuresPerMinute: r.int('AUTH_FAILURES_PER_MINUTE', 10, 1, 10_000),
    },
    logging: {
      level: r.oneOf<LogLevel>('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error', 'silent']),
      urlMode: r.oneOf<UrlLogMode>('LOG_URLS', 'host', ['full', 'host', 'none']),
    },
    queue: {
      concurrency: r.int('MAX_CONCURRENT_JOBS', 4, 1, 256),
      maxSize: r.int('MAX_QUEUE_SIZE', 100, 0, 100_000),
      queueTimeoutMs: r.int('QUEUE_TIMEOUT_MS', 60_000, 100, 3_600_000),
      asyncJobTtlMs: r.int('ASYNC_JOB_TTL_MS', 15 * 60_000, 1_000, 86_400_000),
      maxAsyncJobs: r.int('MAX_ASYNC_JOBS', 10_000, 1, 1_000_000),
    },
    agent: {
      jobTimeoutMs: r.int('JOB_TIMEOUT_MS', 150_000, 1_000, 1_800_000),
      navigationTimeoutMs: r.int('NAVIGATION_TIMEOUT_MS', 30_000, 1_000, 300_000),
      actionTimeoutMs: r.int('ACTION_TIMEOUT_MS', 5_000, 500, 60_000),
      maxSteps: r.int('MAX_STEPS', 30, 1, 500),
      maxCountdownWaitMs: r.int('MAX_COUNTDOWN_WAIT_MS', 90_000, 0, 1_800_000),
      challengeAutoWaitMs: r.int('CHALLENGE_AUTO_WAIT_MS', 8_000, 0, 120_000),
      maxChainDepth: r.int('MAX_CHAIN_DEPTH', 2, 0, 10),
      maxRequestsPerJob: r.int('MAX_REQUESTS_PER_JOB', 3_000, 10, 1_000_000),
      maxBytesPerJob: r.int('MAX_BYTES_PER_JOB', 100 * 1024 * 1024, 1024 * 1024, 10 * 1024 * 1024 * 1024),
      settleMs: r.int('SETTLE_MS', 2_500, 100, 30_000),
      retryOnBrowserCrash: r.bool('RETRY_ON_BROWSER_CRASH', true),
    },
    browser: {
      headless: r.bool('BROWSER_HEADLESS', true),
      executablePath: r.optStr('BROWSER_EXECUTABLE_PATH'),
      sandbox: r.bool('BROWSER_SANDBOX', false),
      recycleAfterJobs: r.int('BROWSER_RECYCLE_AFTER_JOBS', 100, 1, 1_000_000),
      launchTimeoutMs: r.int('BROWSER_LAUNCH_TIMEOUT_MS', 30_000, 1_000, 300_000),
      userAgent,
      blockResourceTypes,
      blockAdDomains: r.bool('BLOCK_AD_DOMAINS', false),
      extraArgs: r.list('BROWSER_EXTRA_ARGS'),
    },
    network: {
      allowedPorts: parsePorts(r),
      allowPrivateCidrs,
      domainDenylist: r.list('DOMAIN_DENYLIST').map(normaliseDomain),
      destinationDenylist: r.list('DESTINATION_DENYLIST').map(normaliseDomain),
      dnsCacheTtlMs: r.int('DNS_CACHE_TTL_MS', 30_000, 0, 3_600_000),
    },
    shorteners: {
      allowUnlisted: r.bool('ALLOW_UNLISTED_SHORTENERS', false),
      adlinkflyExtraDomains: r.list('ADLINKFLY_EXTRA_DOMAINS').map(normaliseDomain),
      disabledModules: r.list('DISABLED_SHORTENER_MODULES').map((s) => s.toLowerCase()),
    },
    extraction: {
      followTrackingRedirects: r.bool('FOLLOW_TRACKING_REDIRECTS', true),
      stripTrackingParams: r.bool('STRIP_TRACKING_PARAMS', true),
      maxRedirectHops: r.int('MAX_REDIRECT_HOPS', 5, 0, 20),
    },
    cache: {
      ttlMs: r.int('RESULT_CACHE_TTL_MS', 10 * 60_000, 0, 7 * 86_400_000),
      maxEntries: r.int('RESULT_CACHE_MAX_ENTRIES', 5_000, 0, 1_000_000),
    },
    ai: {
      provider: aiProvider,
      apiKey: aiApiKey,
      baseUrl: aiBaseUrl.replace(/\/+$/, ''),
      model: aiModel,
      timeoutMs: r.int('AI_TIMEOUT_MS', 20_000, 1_000, 120_000),
      maxCallsPerJob: r.int('AI_MAX_CALLS_PER_JOB', 4, 0, 50),
      jsonMode: r.bool('AI_JSON_MODE', true),
    },
    captcha: {
      provider: captchaProvider,
      apiKey: captchaApiKey,
      baseUrl: captchaBaseUrl.replace(/\/+$/, ''),
      timeoutMs: r.int('CAPTCHA_TIMEOUT_MS', 120_000, 1_000, 300_000),
      pollIntervalMs: r.int('CAPTCHA_POLL_INTERVAL_MS', 5_000, 500, 30_000),
      maxSolvesPerJob: r.int('CAPTCHA_MAX_SOLVES_PER_JOB', 0, 0, 20),
    },
    metrics: {
      enabled: r.bool('METRICS_ENABLED', true),
      requireAuth: r.bool('METRICS_REQUIRE_AUTH', true),
    },
  };

  if (aiProvider !== 'none' && !aiApiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(aiBaseUrl)) {
    r.problems.push('AI_API_KEY is required when AI_PROVIDER is enabled');
  }
  if (captchaProvider !== 'none') {
    if (!captchaApiKey) r.problems.push('CAPTCHA_API_KEY is required when CAPTCHA_PROVIDER is enabled');
    if (config.captcha.maxSolvesPerJob === 0) {
      r.problems.push('CAPTCHA_MAX_SOLVES_PER_JOB must be greater than 0 to enable the CAPTCHA solver');
    }
    if (config.captcha.timeoutMs > config.agent.jobTimeoutMs) {
      r.problems.push('CAPTCHA_TIMEOUT_MS must not exceed JOB_TIMEOUT_MS (the solve would outlive the job)');
    }
  }
  if (config.agent.navigationTimeoutMs > config.agent.jobTimeoutMs) {
    r.problems.push('NAVIGATION_TIMEOUT_MS must not exceed JOB_TIMEOUT_MS');
  }

  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return config;
}

/** Utility for operators: prints the SHA-256 digest to place into API_KEY_HASHES. */
export function hashApiKey(key: string): string {
  return sha256(key).toString('hex');
}
