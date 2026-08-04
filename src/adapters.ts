/**
 * Portal adapters.
 *
 * There is NO real portal adapter in this MVP. The `live` adapter exists only to
 * fail closed, so that a misconfigured deployment can never silently do nothing
 * and report success. The `mock` adapter is a local sandbox for tests and the
 * demo; it performs no network I/O and is refused outright in production.
 *
 * No adapter may ever solve a CAPTCHA, complete an MFA challenge, or accept a
 * legal declaration on a human's behalf. Those conditions return HALTED and the
 * submission worker never resumes a HALTED submission automatically.
 */
import { sha256 } from './audit.js';
import type { Manifest } from './core.js';

export type Outcome = 'SUCCEEDED' | 'HALTED' | 'RETRYABLE_FAILED' | 'TERMINAL_FAILED';

export interface AdapterResult {
  outcome: Outcome;
  code: string;
  detail: string;
  receipt?: string;
}

export interface AdapterRequest {
  destination: string;
  action: string;
  fingerprint: string;
  manifest: Manifest;
  attempt: number;
}

export type Adapter = (req: AdapterRequest) => Promise<AdapterResult>;

export const PORTAL_NO_ADAPTER = 'PORTAL_NO_ADAPTER';
export const SIMULATION_FORBIDDEN_IN_PRODUCTION = 'SIMULATION_FORBIDDEN_IN_PRODUCTION';

/** Real submissions are not implemented. Fail closed, terminally, every time. */
export const liveAdapter: Adapter = async () => ({
  outcome: 'TERMINAL_FAILED',
  code: PORTAL_NO_ADAPTER,
  detail: 'no portal adapter is implemented; live submission is refused',
});

/** Local sandbox. Never used in production. Behaviour is chosen by the destination path. */
export const mockAdapter: Adapter = async (req) => {
  const path = new URL(req.destination).pathname;
  if (path.endsWith('/captcha')) {
    return { outcome: 'HALTED', code: 'CAPTCHA_REQUIRED', detail: 'portal presented a CAPTCHA; a human must complete it' };
  }
  if (path.endsWith('/mfa')) {
    return { outcome: 'HALTED', code: 'MFA_REQUIRED', detail: 'portal requested MFA; a human must complete it' };
  }
  if (path.endsWith('/declaration')) {
    return {
      outcome: 'HALTED',
      code: 'LEGAL_DECLARATION_REQUIRED',
      detail: 'portal requires a signed legal declaration; a human must sign it',
    };
  }
  if (path.endsWith('/reject')) {
    return { outcome: 'TERMINAL_FAILED', code: 'PORTAL_REJECTED', detail: 'sandbox portal rejected the package' };
  }
  if (path.endsWith('/flaky') && req.attempt < 2) {
    return { outcome: 'RETRYABLE_FAILED', code: 'PORTAL_TIMEOUT', detail: 'sandbox portal timed out' };
  }
  return {
    outcome: 'SUCCEEDED',
    code: 'PORTAL_ACCEPTED',
    detail: `sandbox portal accepted ${req.action}`,
    receipt: `SBX-${sha256(req.fingerprint + req.action + req.destination).slice(0, 16).toUpperCase()}`,
  };
};

export class AdapterRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const ADAPTER_NAMES = ['live', 'mock'] as const;

/**
 * Resolve an adapter name against the environment.
 * Production may only ever get the live (fail-closed) adapter.
 */
export function selectAdapter(name: string, env: NodeJS.ProcessEnv = process.env): Adapter {
  const isProduction = env.NODE_ENV === 'production';
  if (name === 'live') return liveAdapter;
  if (name === 'mock') {
    if (isProduction) {
      throw new AdapterRefused(
        SIMULATION_FORBIDDEN_IN_PRODUCTION,
        'the mock/sandbox adapter is forbidden when NODE_ENV=production',
      );
    }
    if (env.ALLOW_SIMULATION !== 'true') {
      throw new AdapterRefused(
        SIMULATION_FORBIDDEN_IN_PRODUCTION,
        'set ALLOW_SIMULATION=true to use the sandbox adapter outside production',
      );
    }
    return mockAdapter;
  }
  throw new AdapterRefused('UNKNOWN_ADAPTER', `unknown adapter ${name}`);
}
