/**
 * Generates an API key (or hashes a given one) for API_KEYS / API_KEY_HASHES.
 *   npm run keygen              -> new random key + its SHA-256 digest
 *   npm run keygen -- <key>     -> SHA-256 digest of an existing key
 */
import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../config.ts';

const given = process.argv[2];
const key = given ?? `alr_${randomBytes(24).toString('base64url')}`;
process.stdout.write(
  `${given ? '' : `API key (give this to the client): ${key}\n`}SHA-256 digest (put into API_KEY_HASHES): ${hashApiKey(key)}\n`,
);
