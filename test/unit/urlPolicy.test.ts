import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UrlPolicy, urlCacheKey } from '../../src/security/urlPolicy.ts';
import { AppError } from '../../src/errors.ts';

const policy = new UrlPolicy({ allowedPorts: new Set([80, 443]), allowPrivateCidrs: [], domainDenylist: ['evil.example'] });

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof AppError);
    return err.code;
  }
}

test('accepts and normalises valid http(s) URLs', () => {
  assert.equal(policy.parseSubmittedUrl('https://AroLinks.com/abc').href, 'https://arolinks.com/abc');
  assert.equal(policy.parseSubmittedUrl('  https://arolinks.com./abc  ').hostname, 'arolinks.com');
  assert.equal(policy.parseSubmittedUrl('arolinks.com/xyz').href, 'https://arolinks.com/xyz');
  assert.equal(policy.parseSubmittedUrl('http://arolinks.com:80/x').href, 'http://arolinks.com/x');
});

test('rejects malformed input and unsupported schemes', () => {
  assert.equal(
    code(() => policy.parseSubmittedUrl(42)),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('javascript:alert(1)')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('file:///etc/passwd')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('data:text/html,hi')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('ftp://example.com/')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('https://user:pass@example.com/')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl('https://exa mple.com/')),
    'INVALID_URL',
  );
  assert.equal(
    code(() => policy.parseSubmittedUrl(`https://example.com/${'a'.repeat(3000)}`)),
    'INVALID_URL',
  );
});

test('blocks SSRF targets: private IPs in every notation, internal names, ports, deny-list', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.0.0.1/', // hex
    'http://0177.0.0.1/', // octal
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.0.1/',
    'http://localhost/',
    'http://app.localhost/',
    'http://metadata.google.internal/',
    'http://printer.local/',
    'http://intranet/',
    'https://example.com:8080/',
    'https://evil.example/',
    'https://sub.evil.example/',
  ];
  for (const u of blocked)
    assert.equal(
      code(() => policy.parseSubmittedUrl(u)),
      'URL_NOT_ALLOWED',
      u,
    );
});

test('network URL checks used for every browser request', () => {
  assert.equal(policy.checkNetworkUrl('https://cdn.example.com/a.js').allowed, true);
  assert.equal(policy.checkNetworkUrl('wss://socket.example.com/').allowed, true);
  assert.equal(policy.checkNetworkUrl('http://192.168.1.1/').allowed, false);
  assert.equal(policy.checkNetworkUrl('chrome://settings').allowed, false);
  assert.equal(policy.checkNetworkUrl('http://example.com:22/').allowed, false);
});

test('private-network exemptions only apply to configured CIDRs', () => {
  const p = new UrlPolicy({ allowedPorts: 'any', allowPrivateCidrs: ['127.0.0.1/32'], domainDenylist: [] });
  assert.equal(p.checkAddress('127.0.0.1').allowed, true);
  assert.equal(p.checkAddress('127.0.0.2').allowed, false);
  assert.equal(p.checkAddress('10.0.0.1').allowed, false);
});

test('cache key drops the fragment', () => {
  assert.equal(urlCacheKey(new URL('https://a.example/x?y=1#frag')), 'https://a.example/x?y=1');
});
