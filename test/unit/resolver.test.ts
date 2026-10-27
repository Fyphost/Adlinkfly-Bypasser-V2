import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DnsResolutionError, EgressPolicyError, SafeResolver, type LookupAllFn } from '../../src/security/resolver.ts';
import { UrlPolicy } from '../../src/security/urlPolicy.ts';

const policy = new UrlPolicy({ allowedPorts: 'any', allowPrivateCidrs: [], domainDenylist: [] });

function makeLookup(map: Record<string, string[]>, calls: string[] = []): LookupAllFn {
  return async (host) => {
    calls.push(host);
    const addrs = map[host];
    if (!addrs) {
      const e = new Error('ENOTFOUND') as NodeJS.ErrnoException;
      e.code = 'ENOTFOUND';
      throw e;
    }
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
  };
}

test('resolves public hosts and caches answers', async () => {
  const calls: string[] = [];
  const r = new SafeResolver({ policy, lookupAll: makeLookup({ 'good.example': ['93.184.216.34'] }, calls), cacheTtlMs: 60_000 });
  assert.deepEqual(await r.resolve('good.example'), [{ address: '93.184.216.34', family: 4 }]);
  await r.resolve('GOOD.example.');
  assert.equal(calls.length, 1);
});

test('rejects hosts resolving to private addresses, including mixed answers (rebinding)', async () => {
  const r = new SafeResolver({
    policy,
    lookupAll: makeLookup({ 'rebind.example': ['93.184.216.34', '127.0.0.1'], 'meta.example': ['169.254.169.254'], 'v6.example': ['::1'] }),
    cacheTtlMs: 60_000,
  });
  await assert.rejects(r.resolve('rebind.example'), EgressPolicyError);
  await assert.rejects(r.resolve('meta.example'), EgressPolicyError);
  await assert.rejects(r.resolve('v6.example'), EgressPolicyError);
});

test('validates IP literals without DNS and reports DNS failures', async () => {
  const calls: string[] = [];
  const r = new SafeResolver({ policy, lookupAll: makeLookup({}, calls), cacheTtlMs: 60_000 });
  assert.deepEqual(await r.resolve('8.8.8.8'), [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(r.resolve('10.0.0.1'), EgressPolicyError);
  await assert.rejects(r.resolve('[::1]'), EgressPolicyError);
  await assert.rejects(r.resolve('missing.example'), DnsResolutionError);
  assert.deepEqual(calls, ['missing.example']);
});

test('lookupFunction only yields validated addresses', async () => {
  const r = new SafeResolver({ policy, lookupAll: makeLookup({ 'ok.example': ['1.1.1.1'], 'bad.example': ['10.0.0.1'] }), cacheTtlMs: 0 });
  const lookup = r.lookupFunction();
  const call = (host: string) =>
    new Promise<string>((resolve, reject) =>
      (lookup as unknown as (h: string, o: object, cb: (e: Error | null, a?: string) => void) => void)(host, {}, (e, a) =>
        e ? reject(e) : resolve(a!),
      ),
    );
  assert.equal(await call('ok.example'), '1.1.1.1');
  await assert.rejects(call('bad.example'), EgressPolicyError);
});
