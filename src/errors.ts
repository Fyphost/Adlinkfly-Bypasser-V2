/**
 * Central error catalogue. Every failure surfaced by the service is an
 * {@link AppError} carrying a stable machine-readable code, an HTTP status and
 * a resolution status. Unknown errors are normalised by {@link toAppError} so
 * that internal details never leak to API clients.
 */

export type ResolutionStatus =
  | 'resolved'
  | 'failed'
  | 'invalid_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'forbidden'
  | 'unsupported'
  | 'human_verification_required'
  | 'link_unavailable'
  | 'timeout'
  | 'unavailable';

interface ErrorSpec {
  http: number;
  status: ResolutionStatus;
  message: string;
}

export const ERROR_CATALOG = {
  INVALID_REQUEST: { http: 400, status: 'invalid_request', message: 'The request is invalid' },
  INVALID_URL: { http: 400, status: 'invalid_request', message: 'The submitted URL is invalid' },
  UNAUTHORIZED: { http: 401, status: 'unauthorized', message: 'A valid API key is required' },
  URL_NOT_ALLOWED: { http: 403, status: 'forbidden', message: 'The submitted URL is not permitted' },
  NAVIGATION_BLOCKED: {
    http: 403,
    status: 'forbidden',
    message: 'The shortener attempted to navigate to a forbidden address',
  },
  DESTINATION_NOT_ALLOWED: {
    http: 403,
    status: 'forbidden',
    message: 'The resolved destination is not permitted by policy',
  },
  NOT_FOUND: { http: 404, status: 'invalid_request', message: 'Resource not found' },
  METHOD_NOT_ALLOWED: { http: 405, status: 'invalid_request', message: 'Method not allowed' },
  PAYLOAD_TOO_LARGE: { http: 413, status: 'invalid_request', message: 'Request body is too large' },
  UNSUPPORTED_MEDIA_TYPE: {
    http: 415,
    status: 'invalid_request',
    message: 'Content-Type must be application/json',
  },
  UNSUPPORTED_SHORTENER: {
    http: 422,
    status: 'unsupported',
    message: 'This URL shortener is not supported',
  },
  HUMAN_VERIFICATION_REQUIRED: {
    http: 422,
    status: 'human_verification_required',
    message: 'Human verification (CAPTCHA or security challenge) is required to continue',
  },
  ADBLOCK_WALL: {
    http: 422,
    status: 'failed',
    message: 'The shortener refused to continue because it detected blocked advertisements',
  },
  LINK_NOT_FOUND: { http: 404, status: 'link_unavailable', message: 'The short link does not exist' },
  LINK_EXPIRED: {
    http: 410,
    status: 'link_unavailable',
    message: 'The short link has expired, been removed or disabled',
  },
  RATE_LIMITED: { http: 429, status: 'rate_limited', message: 'Too many requests' },
  NAVIGATION_FAILED: {
    http: 502,
    status: 'failed',
    message: 'A page in the shortener flow could not be loaded',
  },
  NO_ACTION_FOUND: {
    http: 502,
    status: 'failed',
    message: 'No actionable button or link could be identified on the page',
  },
  MAX_STEPS_EXCEEDED: { http: 502, status: 'failed', message: 'Maximum navigation attempts exceeded' },
  REDIRECT_LOOP: { http: 502, status: 'failed', message: 'The shortener flow entered a redirect loop' },
  UNEXPECTED_PAGE: {
    http: 502,
    status: 'failed',
    message: 'The shortener returned an unexpected page',
  },
  COUNTDOWN_TOO_LONG: {
    http: 504,
    status: 'timeout',
    message: 'The page countdown exceeds the configured maximum wait time',
  },
  TIMEOUT: { http: 504, status: 'timeout', message: 'Resolution timed out' },
  NAVIGATION_TIMEOUT: { http: 504, status: 'timeout', message: 'A page took too long to load' },
  BROWSER_ERROR: {
    http: 503,
    status: 'unavailable',
    message: 'The browser engine failed while processing the request',
  },
  QUEUE_FULL: { http: 503, status: 'unavailable', message: 'The service is at capacity, retry later' },
  QUEUE_TIMEOUT: {
    http: 503,
    status: 'unavailable',
    message: 'The request waited too long in the queue, retry later',
  },
  SHUTTING_DOWN: { http: 503, status: 'unavailable', message: 'The service is shutting down' },
  CANCELLED: { http: 499, status: 'failed', message: 'The request was cancelled' },
  INTERNAL_ERROR: { http: 500, status: 'failed', message: 'An internal error occurred' },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface AppErrorOptions {
  /** Human readable, client-safe description of the specific failure. */
  detail?: string;
  /** Extra client-safe fields merged into the API error response. */
  extra?: Record<string, unknown>;
  cause?: unknown;
  /** Whether the failure is transient and the job may be retried. */
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly status: ResolutionStatus;
  readonly detail: string;
  readonly extra: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const spec: ErrorSpec = ERROR_CATALOG[code];
    super(options.detail ?? spec.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = spec.http;
    this.status = spec.status;
    this.detail = options.detail ?? spec.message;
    this.extra = options.extra ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalises any thrown value into an AppError without leaking internals. */
export function toAppError(err: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (isAppError(err)) return err;
  return new AppError(fallback, { cause: err });
}

/** Extracts a compact description of an unknown error for logs. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      cause: err.cause instanceof Error ? err.cause.message : undefined,
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
