/** Test harness: builds a test configuration and boots the full application. */
import type { AddressInfo } from 'node:net';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { createApp, type App, type AppOverrides } from '../../src/app.ts';
import { Logger } from '../../src/logger.ts';
import { testLookup } from './mockSites.ts';

export const TEST_API_KEY = 'test-key-0123456789abcdef';
export const OTHER_API_KEY = 'other-key-0123456789abcdef';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    API_KEYS: `test:${TEST_API_KEY},other:${OTHER_API_KEY}`,
    LOG_LEVEL: 'silent',
    // The mock sites live on 127.0.0.1: exempt exactly that address from the SSRF block (tests only).
    ALLOW_PRIVATE_NETWORK_CIDRS: '127.0.0.1/32',
    ALLOWED_PORTS: 'any',
    ADLINKFLY_EXTRA_DOMAINS: 'short.test',
    MAX_CONCURRENT_JOBS: '3',
    JOB_TIMEOUT_MS: '90000',
    NAVIGATION_TIMEOUT_MS: '15000',
    SETTLE_MS: '1500',
    RESULT_CACHE_TTL_MS: '0',
    RATE_LIMIT_PER_MINUTE: '1000',
    RATE_LIMIT_BURST: '1000',
    FOLLOW_TRACKING_REDIRECTS: 'false',
    ...overrides,
  });
}

export interface TestApp {
  app: App;
  base: string;
  close(): Promise<void>;
}

export async function startTestApp(configOverrides: Record<string, string> = {}, appOverrides: AppOverrides = {}): Promise<TestApp> {
  const config = testConfig(configOverrides);
  const level = (process.env.TEST_LOG_LEVEL as 'debug' | 'info' | undefined) ?? 'silent';
  const app = await createApp(config, {
    lookupAll: testLookup,
    logger: new Logger({ level, sink: (l) => process.stderr.write(`${l}\n`) }),
    ...appOverrides,
  });
  const addr: AddressInfo = await app.listen();
  return { app, base: `http://127.0.0.1:${addr.port}`, close: () => app.close() };
}

export async function postResolve(
  base: string,
  body: unknown,
  opts: { key?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  const key = opts.key === undefined ? TEST_API_KEY : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/api/resolve`, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}
