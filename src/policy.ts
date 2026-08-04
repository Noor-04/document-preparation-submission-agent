import { lookup } from 'node:dns/promises';

export interface UrlDecision {
  ok: boolean;
  code?: string;
  reason?: string;
  normalized?: string;
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

function reject(code: string, reason: string): UrlDecision {
  return { ok: false, code, reason };
}

/** Hosts are allowed by exact match, or by a leading-dot suffix rule (".gov.example" matches "a.gov.example"). */
function hostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('.') ? host.endsWith(e) : host === e;
  });
}

export function allowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PORTAL_HOST_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Static, offline destination-URL policy. Deliberately deny-by-default: a URL is
 * only usable if it is https, credential-free, on an allowlisted registrable host,
 * on port 443, and free of traversal segments.
 */
export function validateDestination(raw: string, allowlist: string[]): UrlDecision {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return reject('URL_UNPARSEABLE', 'destination is not a valid absolute URL');
  }
  if (u.protocol !== 'https:') return reject('URL_SCHEME_FORBIDDEN', `scheme ${u.protocol} is not https:`);
  if (u.username || u.password) return reject('URL_CREDENTIALS_FORBIDDEN', 'userinfo is not allowed in destinations');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return reject('URL_HOST_MISSING', 'destination has no host');
  if (host.startsWith('[') || IPV4.test(host)) {
    return reject('URL_IP_LITERAL_FORBIDDEN', 'destination must be a hostname, not an IP literal');
  }
  if (u.port && u.port !== '443') return reject('URL_PORT_FORBIDDEN', `port ${u.port} is not allowed`);
  if (allowlist.length === 0) return reject('URL_ALLOWLIST_EMPTY', 'no portal host allowlist is configured');
  if (!hostAllowed(host, allowlist)) return reject('URL_HOST_NOT_ALLOWLISTED', `host ${host} is not allowlisted`);
  return { ok: true, normalized: `https://${host}${u.pathname}${u.search}` };
}

/** RFC1918 / loopback / link-local / CGNAT / multicast / unique-local. */
export function isPrivateAddress(address: string): boolean {
  if (IPV4.test(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = address.toLowerCase().split('%')[0] ?? '';
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return false;
}

/**
 * DNS half of the SSRF policy: every resolved address must be public.
 * Injectable so tests never touch the network.
 */
export async function checkHostAddresses(host: string, resolver: Lookup = defaultLookup): Promise<UrlDecision> {
  let addrs: { address: string }[];
  try {
    addrs = await resolver(host);
  } catch {
    return reject('URL_DNS_FAILED', `could not resolve ${host}`);
  }
  if (addrs.length === 0) return reject('URL_DNS_FAILED', `no addresses for ${host}`);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) return reject('URL_PRIVATE_ADDRESS', `${host} resolves to non-public address ${bad.address}`);
  return { ok: true };
}

const defaultLookup: Lookup = (host) => lookup(host, { all: true });
