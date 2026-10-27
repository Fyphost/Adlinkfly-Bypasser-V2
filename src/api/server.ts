/**
 * HTTP API: routing, authentication, rate limiting, request logging, CORS,
 * security headers and the endpoint handlers.
 *
 *   POST /api/resolve        resolve a short link (sync, or async with "async": true)
 *   GET  /api/jobs/:id       poll an asynchronous job
 *   GET  /api/shorteners     list supported shortener modules
 *   GET  /health             liveness
 *   GET  /ready              readiness (browser + queue)
 *   GET  /metrics            Prometheus metrics
 */
import http from 'node:http';
import type { AppConfig } from '../config.ts';
import { AppError, toAppError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { ResolverService } from '../service/resolverService.ts';
import type { JobStore } from '../service/jobStore.ts';
import type { ShortenerRegistry } from '../shorteners/registry.ts';
import { Authenticator } from './auth.ts';
import { RateLimiter, rateHeaders } from './rateLimiter.ts';
import { SECURITY_HEADERS, clientIp, readJsonBody, requestIdFrom, sendJson, sendText } from './http.ts';
import { errorBody, originalUrlOf, successBody } from './responses.ts';

export interface ReadinessInfo {
  ready: boolean;
  details: Record<string, unknown>;
}

export interface ServerDeps {
  config: AppConfig;
  service: ResolverService;
  jobs: JobStore;
  registry: ShortenerRegistry;
  metrics: Metrics;
  logger: Logger;
  readiness: () => ReadinessInfo;
  version: string;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  ip: string;
  keyId: string | null;
  params: Record<string, string>;
}

type Handler = (ctx: RequestContext) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  name: string;
  auth: boolean;
  limiter?: RateLimiter;
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${src}/?$`), keys };
}

interface ResolveRequest {
  url: unknown;
  async: boolean;
  includeTrace: boolean;
  noCache: boolean;
}

function parseResolveBody(body: unknown): ResolveRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INVALID_REQUEST', { detail: 'The request body must be a JSON object' });
  }
  const b = body as Record<string, unknown>;
  if (b.url === undefined || b.url === null) throw new AppError('INVALID_REQUEST', { detail: 'The "url" field is required' });
  const flag = (name: string): boolean => {
    const v = b[name];
    if (v === undefined || v === null) return false;
    if (typeof v !== 'boolean') throw new AppError('INVALID_REQUEST', { detail: `The "${name}" field must be a boolean` });
    return v;
  };
  return { url: b.url, async: flag('async'), includeTrace: flag('include_trace'), noCache: flag('no_cache') };
}

export interface ApiServer extends http.Server {
  /** Number of HTTP requests whose response has not been completed yet. */
  inflightRequests(): number;
}

export function createServer(deps: ServerDeps): ApiServer {
  const { config, service, jobs, registry, metrics, logger } = deps;
  const auth = new Authenticator(config.auth);
  const resolveLimiter = new RateLimiter({ perMinute: config.rateLimit.perMinute, burst: config.rateLimit.burst });
  const readLimiter = new RateLimiter({ perMinute: config.rateLimit.perMinute * 10, burst: config.rateLimit.burst * 10 });
  const authFailures = new RateLimiter({
    perMinute: config.rateLimit.authFailuresPerMinute,
    burst: config.rateLimit.authFailuresPerMinute,
  });
  const accessLog = logger.child({ component: 'http' });

  const pruneTimer = setInterval(() => {
    resolveLimiter.prune();
    readLimiter.prune();
    authFailures.prune();
  }, 60_000);
  pruneTimer.unref();

  const routes: Route[] = [];
  const add = (method: string, path: string, name: string, opts: { auth: boolean; limiter?: RateLimiter }, handler: Handler) => {
    routes.push({ method, ...compile(path), name, auth: opts.auth, limiter: opts.limiter, handler });
  };

  // ------------------------------------------------------------------ routes

  add('GET', '/', 'root', { auth: false }, async ({ res }) => {
    sendJson(res, 200, {
      name: 'adlinkfly-resolver',
      version: deps.version,
      endpoints: ['POST /api/resolve', 'GET /api/jobs/:id', 'GET /api/shorteners', 'GET /health', 'GET /ready', 'GET /metrics'],
    });
  });

  add('GET', '/health', 'health', { auth: false }, async ({ res }) => {
    sendJson(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  add('GET', '/ready', 'ready', { auth: false }, async ({ res }) => {
    const r = deps.readiness();
    sendJson(res, r.ready ? 200 : 503, { status: r.ready ? 'ready' : 'not_ready', ...r.details });
  });

  if (config.metrics.enabled) {
    add('GET', '/metrics', 'metrics', { auth: config.metrics.requireAuth, limiter: readLimiter }, async ({ res }) => {
      sendText(res, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
    });
  }

  add('GET', '/api/shorteners', 'shorteners', { auth: true, limiter: readLimiter }, async ({ res, requestId }) => {
    sendJson(res, 200, {
      success: true,
      allow_unlisted: config.shorteners.allowUnlisted,
      shorteners: registry.list(),
      request_id: requestId,
    });
  });

  add('GET', '/api/jobs/:id', 'job', { auth: true, limiter: readLimiter }, async ({ res, params, keyId, requestId }) => {
    const job = jobs.get(params.id ?? '', keyId ?? 'anonymous');
    if (!job) throw new AppError('NOT_FOUND', { detail: 'Job not found or expired' });
    if (job.status === 'completed' || job.status === 'failed') {
      sendJson(res, 200, {
        job_id: job.id,
        job_status: job.status,
        http_status: job.httpStatus,
        ...job.result,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });
      return;
    }
    sendJson(res, 200, {
      success: true,
      job_id: job.id,
      job_status: job.status,
      status: job.status,
      original_url: job.originalUrl,
      destination_url: null,
      message: job.status === 'queued' ? 'The job is waiting in the queue' : 'The job is being processed',
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      request_id: requestId,
    });
  });

  add('POST', '/api/resolve', 'resolve', { auth: true, limiter: resolveLimiter }, async (ctx) => {
    const { req, res, requestId, keyId } = ctx;
    let originalUrl: string | null = null;
    let body: ResolveRequest;
    try {
      const raw = await readJsonBody(req, config.server.maxBodyBytes);
      originalUrl = originalUrlOf(raw);
      body = parseResolveBody(raw);
    } catch (err) {
      const e = toAppError(err, 'INVALID_REQUEST');
      sendJson(res, e.httpStatus, errorBody(e, originalUrl, requestId), e.code === 'PAYLOAD_TOO_LARGE' ? { Connection: 'close' } : {});
      return;
    }

    if (body.async) {
      // Validate synchronously so obviously bad requests fail fast instead of producing a failed job.
      try {
        await service.prepare(body.url);
      } catch (err) {
        const e = toAppError(err);
        sendJson(res, e.httpStatus, errorBody(e, originalUrl, requestId));
        return;
      }
      const job = jobs.create(keyId ?? 'anonymous', originalUrl ?? '');
      void service
        .resolve(body.url, {
          requestId: job.id,
          noCache: body.noCache,
          includeTrace: body.includeTrace,
          onStart: () => jobs.update(job.id, { status: 'running' }),
        })
        .then(
          (r) => jobs.update(job.id, { status: 'completed', httpStatus: 200, result: successBody(r, job.id, originalUrl) }),
          (err: unknown) => {
            const e = toAppError(err);
            jobs.update(job.id, { status: 'failed', httpStatus: e.httpStatus, result: errorBody(e, originalUrl, job.id) });
          },
        );
      sendJson(
        res,
        202,
        {
          success: true,
          status: 'queued',
          job_id: job.id,
          original_url: originalUrl,
          destination_url: null,
          message: 'Resolution job accepted',
          status_url: `/api/jobs/${job.id}`,
          request_id: requestId,
        },
        { Location: `/api/jobs/${job.id}` },
      );
      return;
    }

    const controller = new AbortController();
    if (config.server.cancelOnClientDisconnect) {
      res.on('close', () => {
        if (!res.writableFinished) controller.abort(new AppError('CANCELLED', { detail: 'The client disconnected' }));
      });
    }
    try {
      const result = await service.resolve(body.url, {
        requestId,
        noCache: body.noCache,
        includeTrace: body.includeTrace,
        signal: controller.signal,
      });
      sendJson(res, 200, successBody(result, requestId, originalUrl));
    } catch (err) {
      const e = toAppError(err);
      const headers: Record<string, string> = {};
      const retry = e.extra.retry_after;
      if (typeof retry === 'number') headers['Retry-After'] = String(retry);
      sendJson(res, e.httpStatus, errorBody(e, originalUrl, requestId), headers);
    }
  });

  // ---------------------------------------------------------------- dispatch

  const corsAllowed = (origin: string | undefined): string | null => {
    if (!origin || config.server.corsOrigins.length === 0) return null;
    if (config.server.corsOrigins.includes('*')) return '*';
    return config.server.corsOrigins.includes(origin) ? origin : null;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = Date.now();
    const requestId = requestIdFrom(req);
    const ip = clientIp(req, config.server.trustProxyHops);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-Id', requestId);
    let routeName = 'unmatched';
    let keyId: string | null = null;

    // 'close' fires for completed and aborted exchanges alike, so client disconnects are logged too.
    res.once('close', () => {
      const completed = res.writableFinished;
      const status = completed ? res.statusCode : 499;
      metrics.httpRequests.inc({ route: routeName, status: String(status) });
      accessLog.info('request', {
        request_id: requestId,
        method,
        path: path.slice(0, 200),
        route: routeName,
        status,
        completed,
        ms: Date.now() - started,
        ip,
        key: keyId ?? undefined,
        ua: String(req.headers['user-agent'] ?? '').slice(0, 120) || undefined,
      });
    });

    const origin = corsAllowed(req.headers.origin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
    }
    if (method === 'OPTIONS') {
      if (origin) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type, X-Request-Id');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const fail = (e: AppError, headers: Record<string, string> = {}) => sendJson(res, e.httpStatus, errorBody(e, null, requestId), headers);

    const candidates = routes.filter((r) => r.pattern.test(path));
    if (candidates.length === 0) {
      fail(new AppError('NOT_FOUND', { detail: `No route for ${path.slice(0, 100)}` }));
      return;
    }
    const route = candidates.find((r) => r.method === method || (method === 'HEAD' && r.method === 'GET'));
    if (!route) {
      res.setHeader('Allow', [...new Set(candidates.map((r) => r.method))].join(', '));
      fail(new AppError('METHOD_NOT_ALLOWED'));
      return;
    }
    routeName = route.name;
    const match = route.pattern.exec(path)!;
    const params: Record<string, string> = {};
    try {
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(match[i + 1] ?? '');
      });
    } catch {
      fail(new AppError('NOT_FOUND', { detail: 'Malformed path parameter' }));
      return;
    }

    if (route.auth) {
      if (!auth.disabled && authFailures.isExhausted(`ip:${ip}`)) {
        const d = authFailures.take(`ip:${ip}`, 0);
        fail(new AppError('RATE_LIMITED', { detail: 'Too many failed authentication attempts' }), {
          'Retry-After': String(Math.max(1, d.retryAfter || 60)),
        });
        return;
      }
      const result = auth.authenticate(req);
      if (!result.ok) {
        authFailures.take(`ip:${ip}`);
        fail(
          new AppError('UNAUTHORIZED', {
            detail: result.reason === 'missing' ? 'Missing API key (use Authorization: Bearer <key> or X-API-Key)' : 'Invalid API key',
          }),
          {
            'WWW-Authenticate': 'Bearer realm="api"',
          },
        );
        return;
      }
      keyId = result.keyId;
    }
    if (route.limiter) {
      const bucket = keyId && keyId !== 'anonymous' ? `key:${keyId}` : `ip:${ip}`;
      const d = route.limiter.take(bucket);
      for (const [k, v] of Object.entries(rateHeaders(d))) res.setHeader(k, v);
      if (!d.allowed) {
        fail(
          new AppError('RATE_LIMITED', { detail: `Rate limit exceeded, retry in ${d.retryAfter} s`, extra: { retry_after: d.retryAfter } }),
        );
        return;
      }
    }
    await route.handler({ req, res, requestId, ip, keyId, params });
  };

  let inflight = 0;
  const server = http.createServer((req, res) => {
    inflight++;
    res.once('close', () => inflight--);
    handle(req, res).catch((err: unknown) => {
      const e = toAppError(err);
      if (e.code === 'INTERNAL_ERROR')
        logger.error('unhandled request error', { error: (err as Error)?.message, stack: (err as Error)?.stack });
      sendJson(res, e.httpStatus, errorBody(e, null, String(res.getHeader('X-Request-Id') ?? '')));
    });
  });
  server.headersTimeout = config.server.headersTimeoutMs;
  server.requestTimeout = config.server.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => clearInterval(pruneTimer));
  return Object.assign(server, { inflightRequests: () => inflight });
}
