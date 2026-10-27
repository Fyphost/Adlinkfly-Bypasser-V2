import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CidrSet, classifyIp, formatIp, parseCidr, parseIPv4, parseIPv6, parseIp } from '../../src/security/ip.ts';

test('parses IPv4 strictly', () => {
  assert.equal(parseIPv4('1.2.3.4'), 0x01020304n);
  assert.equal(parseIPv4('255.255.255.255'), 0xffffffffn);
  for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-1', 'a.b.c.d', '']) {
    assert.equal(parseIPv4(bad), null, bad);
  }
});

test('parses IPv6 including compression and embedded IPv4', () => {
  assert.equal(parseIPv6('::1'), 1n);
  assert.equal(parseIPv6('::'), 0n);
  assert.equal(parseIPv6('[::1]'), 1n);
  assert.equal(parseIPv6('::ffff:127.0.0.1'), 0xffff7f000001n);
  assert.equal(parseIPv6('2001:db8::1'), 0x20010db8000000000000000000000001n);
  assert.equal(parseIPv6('1:2:3:4:5:6:1.2.3.4'), parseIPv6('1:2:3:4:5:6:102:304'));
  for (const bad of ['1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%eth0', ':::', '12345::1', 'g::1']) {
    assert.equal(parseIPv6(bad), null, bad);
  }
});

test('formats IPv6 canonically (RFC 5952)', () => {
  assert.equal(formatIp(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')!), '2001:db8::1');
  assert.equal(formatIp(parseIp('::1')!), '::1');
  assert.equal(formatIp(parseIp('fe80:0:0:1:0:0:0:1')!), 'fe80:0:0:1::1');
});

test('classifies private, reserved and public IPv4 addresses', () => {
  const nonPublic = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.10',
  ];
  for (const a of nonPublic) assert.equal(classifyIp(a).public, false, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) assert.equal(classifyIp(a).public, true, a);
  assert.equal(classifyIp('169.254.169.254').reason, 'link-local');
});

test('classifies IPv6 including IPv4-mapped, NAT64 and 6to4 embeddings', () => {
  for (const a of [
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:7f00:1::1',
    '2001::1',
  ]) {
    assert.equal(classifyIp(a).public, false, a);
  }
  for (const a of ['2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(classifyIp(a).public, true, a);
  }
});

test('CIDR parsing and membership', () => {
  const c = parseCidr('10.0.0.0/8');
  assert.ok(c);
  assert.equal(parseCidr('10.0.0.0/33'), null);
  assert.equal(parseCidr('nonsense'), null);
  const set = new CidrSet(['127.0.0.1/32', 'fd00::/8']);
  assert.ok(set.contains('127.0.0.1'));
  assert.ok(!set.contains('127.0.0.2'));
  assert.ok(set.contains('fd00::5'));
  assert.ok(!set.contains('example.com'));
});
