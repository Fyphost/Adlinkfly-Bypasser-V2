/** Low-level HTTP helpers: JSON responses, body reading, client IP, request ids. */
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    ...headers,
  });
  res.end(payload);
}

export function sendText(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body).toString() });
  res.end(body);
}

/** Reads a JSON request body with a strict size limit and content-type check. */
export async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/(json|[a-z0-9.+-]*\+json)\s*(;|$)/.test(ct)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', { detail: `Request body must not exceed ${maxBytes} bytes` });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('PAYLOAD_TOO_LARGE', { detail: `Request body must not exceed ${maxBytes} bytes` }));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', (err) => reject(new AppError('INVALID_REQUEST', { detail: 'The request body could not be read', cause: err })));
  });
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new AppError('INVALID_REQUEST', { detail: 'The request body must not be empty' });
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('INVALID_REQUEST', { detail: 'The request body is not valid JSON' });
  }
}

/** Determines the client address, honouring X-Forwarded-For only for the configured number of trusted hops. */
export function clientIp(req: http.IncomingMessage, trustProxyHops: number): string {
  const direct = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  if (trustProxyHops <= 0) return direct;
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length === 0) return direct;
  const idx = Math.max(0, xff.length - trustProxyHops);
  return (xff[idx] ?? direct).replace(/^::ffff:/, '');
}

export function requestIdFrom(req: http.IncomingMessage): string {
  const given = req.headers['x-request-id'];
  if (typeof given === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(given)) return given;
  return randomUUID();
}
