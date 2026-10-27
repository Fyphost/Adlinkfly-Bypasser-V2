/**
 * API-key authentication. Keys are accepted via `Authorization: Bearer <key>`
 * or `X-API-Key: <key>` and compared as SHA-256 digests in constant time.
 */
import type http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.ts';

export type AuthResult = { ok: true; keyId: string } | { ok: false; reason: 'missing' | 'invalid' };

export class Authenticator {
  private readonly cfg: AppConfig['auth'];

  constructor(cfg: AppConfig['auth']) {
    this.cfg = cfg;
  }

  get disabled(): boolean {
    return this.cfg.disabled;
  }

  static extractKey(req: http.IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      if (m) return m[1]!;
    }
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    return null;
  }

  authenticate(req: http.IncomingMessage): AuthResult {
    if (this.cfg.disabled) return { ok: true, keyId: 'anonymous' };
    const key = Authenticator.extractKey(req);
    if (!key) return { ok: false, reason: 'missing' };
    if (key.length > 512) return { ok: false, reason: 'invalid' };
    const digest = createHash('sha256').update(key, 'utf8').digest();
    let match: string | null = null;
    // Compare against every key so timing does not reveal which entry matched.
    for (const entry of this.cfg.keys) {
      if (timingSafeEqual(digest, entry.sha256) && match === null) match = entry.id;
    }
    return match ? { ok: true, keyId: match } : { ok: false, reason: 'invalid' };
  }
}
