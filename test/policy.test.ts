import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHostAddresses, isPrivateAddress, validateDestination, allowlistFromEnv } from '../src/policy.js';
import { ALLOWLIST, ENV } from './support.js';

test('only https destinations are accepted', () => {
  for (const url of ['http://portal.registry.example/submit', 'ftp://portal.registry.example/x', 'file:///etc/passwd']) {
    const d = validateDestination(url, ALLOWLIST);
    assert.equal(d.ok, false);
    assert.equal(d.code, 'URL_SCHEME_FORBIDDEN');
  }
});

test('credentials in the URL are refused', () => {
  const d = validateDestination('https://user:pass@portal.registry.example/submit', ALLOWLIST);
  assert.equal(d.code, 'URL_CREDENTIALS_FORBIDDEN');
});

test('IP literals are refused before any allowlist consideration', () => {
  assert.equal(validateDestination('https://169.254.169.254/latest/meta-data', ALLOWLIST).code, 'URL_IP_LITERAL_FORBIDDEN');
  assert.equal(validateDestination('https://127.0.0.1/submit', ALLOWLIST).code, 'URL_IP_LITERAL_FORBIDDEN');
  assert.equal(validateDestination('https://[::1]/submit', ALLOWLIST).code, 'URL_IP_LITERAL_FORBIDDEN');
});

test('non-443 ports are refused', () => {
  assert.equal(validateDestination('https://portal.registry.example:8443/submit', ALLOWLIST).code, 'URL_PORT_FORBIDDEN');
});

test('dot segments are collapsed, so no traversal reaches the portal', () => {
  // The URL parser resolves both literal and percent-encoded dot segments; the
  // host is fixed by the allowlist, so what survives is always a plain path.
  for (const raw of [
    'https://portal.registry.example/a/../submit',
    'https://portal.registry.example/a/%2e%2e/submit',
    'https://portal.registry.example/a/b/../../submit',
  ]) {
    assert.equal(validateDestination(raw, ALLOWLIST).normalized, 'https://portal.registry.example/submit', raw);
  }
});

test('the allowlist is deny-by-default', () => {
  assert.equal(validateDestination('https://evil.example/submit', ALLOWLIST).code, 'URL_HOST_NOT_ALLOWLISTED');
  assert.equal(validateDestination('https://portal.registry.example/submit', []).code, 'URL_ALLOWLIST_EMPTY');
  // a look-alike host must not sneak past the suffix rule
  assert.equal(validateDestination('https://notgov.example/submit', ALLOWLIST).code, 'URL_HOST_NOT_ALLOWLISTED');
});

test('suffix allowlist entries match subdomains only', () => {
  assert.equal(validateDestination('https://filing.gov.example/submit', ALLOWLIST).ok, true);
});

test('accepted destinations are normalised for approval binding', () => {
  const d = validateDestination('https://PORTAL.Registry.Example:443/submit?x=1#frag', ALLOWLIST);
  assert.equal(d.ok, true);
  assert.equal(d.normalized, 'https://portal.registry.example/submit?x=1');
});

test('unparseable input is refused rather than coerced', () => {
  assert.equal(validateDestination('not a url', ALLOWLIST).code, 'URL_UNPARSEABLE');
  assert.equal(validateDestination('', ALLOWLIST).code, 'URL_UNPARSEABLE');
});

test('private and reserved addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(a), true, `${a} should be private`);
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateAddress(a), false, `${a} should be public`);
  }
});

test('DNS rebinding to a private address is refused', async () => {
  const priv = await checkHostAddresses('portal.registry.example', async () => [{ address: '10.0.0.5', family: 4 }]);
  assert.equal(priv.code, 'URL_PRIVATE_ADDRESS');

  const mixed = await checkHostAddresses('portal.registry.example', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  assert.equal(mixed.code, 'URL_PRIVATE_ADDRESS', 'every resolved address must be public');

  const pub = await checkHostAddresses('portal.registry.example', async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(pub.ok, true);

  const failed = await checkHostAddresses('portal.registry.example', async () => {
    throw new Error('ENOTFOUND');
  });
  assert.equal(failed.code, 'URL_DNS_FAILED');

  const empty = await checkHostAddresses('portal.registry.example', async () => []);
  assert.equal(empty.code, 'URL_DNS_FAILED');
});

test('allowlist is read from the environment', () => {
  assert.deepEqual(allowlistFromEnv(ENV), ALLOWLIST);
  assert.deepEqual(allowlistFromEnv({}), []);
});
