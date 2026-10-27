/** Builders for the public JSON response shapes. */
import type { AppError } from '../errors.ts';
import type { ResolveSuccess } from '../service/resolverService.ts';

/** `submittedUrl`: the URL exactly as the client sent it (falls back to the normalised URL). */
export function successBody(r: ResolveSuccess, requestId: string, submittedUrl?: string | null): Record<string, unknown> {
  return {
    success: true,
    status: 'resolved',
    original_url: submittedUrl || r.originalUrl,
    destination_url: r.destinationUrl,
    message: 'Destination URL resolved successfully',
    shortener: r.shortener,
    steps: r.steps,
    duration_ms: r.durationMs,
    cached: r.cached,
    ...(r.chain.length > 0 ? { chain: r.chain } : {}),
    ...(r.trace ? { trace: r.trace } : {}),
    request_id: requestId,
  };
}

function headline(e: AppError): string {
  switch (e.status) {
    case 'human_verification_required':
      return 'Human verification is required; the link cannot be resolved automatically';
    case 'link_unavailable':
      return 'The short link is not available';
    case 'invalid_request':
      return 'Invalid request';
    case 'unauthorized':
      return 'Authentication required';
    case 'rate_limited':
      return 'Rate limit exceeded';
    case 'forbidden':
      return 'The request was refused by the security policy';
    case 'unsupported':
      return 'Unsupported shortener';
    case 'unavailable':
      return 'The service is temporarily unavailable';
    default:
      return 'Unable to resolve the destination URL';
  }
}

/** Fields from AppError.extra that may be exposed to clients. */
const EXPOSED_EXTRA = new Set([
  'verification_url',
  'challenge_type',
  'steps',
  'last_url',
  'page_messages',
  'supported',
  'retry_after',
  'trace',
  'candidates_seen',
]);

export function errorBody(e: AppError, originalUrl: string | null, requestId: string): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.extra)) if (EXPOSED_EXTRA.has(k) && v !== undefined) extra[k] = v;
  return {
    success: false,
    status: e.status,
    original_url: originalUrl,
    destination_url: null,
    message: headline(e),
    error: e.detail,
    error_code: e.code,
    ...extra,
    request_id: requestId,
  };
}

export function originalUrlOf(body: unknown): string | null {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).url === 'string') {
    return ((body as Record<string, string>).url ?? '').trim().slice(0, 2048);
  }
  return null;
}
