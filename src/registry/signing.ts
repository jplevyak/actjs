/**
 * Signing-key registry for class publishing.
 *
 * A signing key is an Ed25519 public key identified by `kid`. The
 * publish path verifies a signature over `sha256:<hex>|<name>@<version>`
 * (see {@link signingMessage} in `./publisher.ts`).
 *
 * Two backends:
 *
 * - `MemorySigningKeyRegistry` — single-node, used by tests and the
 *   in-memory driver. Holds the keys in a plain Map.
 * - PG-backed implementation lives in `valkey-pg.ts` (migration
 *   `0003_signing_keys.up.sql`). Both implement the same
 *   `SigningKeyRegistry` interface.
 *
 * The registry separates "store" (`add`, `revoke`, `list`) from
 * "verify" (used by `publishClass`). The Auditor records every
 * mutation (`signing-key.added`, `signing-key.revoked`).
 */
import { createPublicKey, verify as nodeVerify, type KeyObject } from 'node:crypto';

import { AUDIT_ACTIONS, type Auditor } from '../audit/index.js';

/* --------------------------------------------------------- Types */

export interface SigningKeyRecord {
  readonly kid: string;
  /** Algorithm. Only `'EdDSA'` is supported in v1. */
  readonly algorithm: 'EdDSA';
  /** PEM-encoded public key. */
  readonly publicKeyPem: string;
  readonly addedAt: number;
  readonly revokedAt?: number;
}

export interface SigningKeyVerifyInput {
  readonly kid: string;
  readonly signature: Buffer;
  readonly message: Buffer;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface SigningKeyVerifier {
  verify(input: SigningKeyVerifyInput): Promise<VerifyResult>;
}

export interface SigningKeyRegistry extends SigningKeyVerifier {
  add(kid: string, publicKeyPem: string, addedBy?: string): Promise<void>;
  revoke(kid: string, revokedBy?: string): Promise<void>;
  get(kid: string): Promise<SigningKeyRecord | null>;
  list(): Promise<readonly SigningKeyRecord[]>;
}

/* --------------------------------------------------------- Errors */

export class SigningKeyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SigningKeyError';
    this.code = code;
  }
}

export class SigningKeyExists extends SigningKeyError {
  constructor(kid: string) {
    super(`signing key ${kid} is already registered`, 'SigningKeyExists');
  }
}

export class SigningKeyNotFound extends SigningKeyError {
  constructor(kid: string) {
    super(`signing key ${kid} is not registered`, 'SigningKeyNotFound');
  }
}

/* --------------------------------------------------------- Memory impl */

interface MemoryRow {
  algorithm: 'EdDSA';
  publicKey: KeyObject;
  publicKeyPem: string;
  addedAt: number;
  revokedAt?: number;
}

export interface MemorySigningKeyRegistryOptions {
  readonly auditor?: Auditor;
  readonly nowMs?: () => number;
}

export class MemorySigningKeyRegistry implements SigningKeyRegistry {
  private readonly rows = new Map<string, MemoryRow>();
  private readonly auditor: Auditor | undefined;
  private readonly now: () => number;

  constructor(options: MemorySigningKeyRegistryOptions = {}) {
    this.auditor = options.auditor;
    this.now = options.nowMs ?? Date.now;
  }

  async add(kid: string, publicKeyPem: string, addedBy = 'system'): Promise<void> {
    if (this.rows.has(kid)) throw new SigningKeyExists(kid);
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new SigningKeyError(
        `unsupported key type ${String(publicKey.asymmetricKeyType)}; expected ed25519`,
        'UnsupportedKeyType',
      );
    }
    this.rows.set(kid, {
      algorithm: 'EdDSA',
      publicKey,
      publicKeyPem,
      addedAt: this.now(),
    });
    if (this.auditor) {
      await this.auditor.record({
        action: AUDIT_ACTIONS.SIGNING_KEY_ADDED,
        target: kid,
        principal: addedBy,
        meta: { algorithm: 'EdDSA' },
      });
    }
  }

  async revoke(kid: string, revokedBy = 'system'): Promise<void> {
    const row = this.rows.get(kid);
    if (!row) throw new SigningKeyNotFound(kid);
    if (row.revokedAt !== undefined) return;
    row.revokedAt = this.now();
    if (this.auditor) {
      await this.auditor.record({
        action: AUDIT_ACTIONS.SIGNING_KEY_REVOKED,
        target: kid,
        principal: revokedBy,
        meta: { revokedAt: row.revokedAt },
      });
    }
  }

  async get(kid: string): Promise<SigningKeyRecord | null> {
    const row = this.rows.get(kid);
    if (!row) return null;
    return toRecord(kid, row);
  }

  async list(): Promise<readonly SigningKeyRecord[]> {
    return Array.from(this.rows.entries()).map(([kid, row]) => toRecord(kid, row));
  }

  async verify(input: SigningKeyVerifyInput): Promise<VerifyResult> {
    const row = this.rows.get(input.kid);
    if (!row) return { ok: false, reason: `signing key ${input.kid} not found` };
    if (row.revokedAt !== undefined) {
      return { ok: false, reason: `signing key ${input.kid} is revoked` };
    }
    try {
      const ok = nodeVerify(null, input.message, row.publicKey, input.signature);
      return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'signature verification threw',
      };
    }
  }
}

function toRecord(kid: string, row: MemoryRow): SigningKeyRecord {
  return {
    kid,
    algorithm: row.algorithm,
    publicKeyPem: row.publicKeyPem,
    addedAt: row.addedAt,
    ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
  };
}
