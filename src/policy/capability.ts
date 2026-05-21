/**
 * Capability tokens.
 *
 * A capability is a short-lived, signed grant that lets the holder
 * invoke a named set of methods on a specific actor — no auth
 * provider, no user, no role lookup. Useful for "shareable read
 * link" patterns and for system-to-system delegation that
 * shouldn't carry a full identity.
 *
 * Wire format: JWT-style, three base64url segments separated by `.`,
 * signed with Ed25519. The header is `{alg:'EdDSA',typ:'JWT'}`; the
 * payload carries:
 *
 *   - `iss`   — issuer name (the server identifier).
 *   - `sub`   — actor reference `class:id`.
 *   - `aud?`  — optional audience claim.
 *   - `mth`   — array of method names the token grants.
 *   - `exp`   — unix-epoch seconds; required.
 *   - `nbf?`  — optional "not before."
 *   - `jti`   — token id; used by the revocation blocklist.
 *
 * Presentation: `Authorization: Capability <jwt>`. The auth hook
 * (or a dedicated parser; see `parseCapabilityHeader`) decodes,
 * verifies, and exposes the methods on the {@link Principal} as
 * `capabilities: ["call:addItem", ...]` so `policy()` can reference
 * them.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

/* --------------------------------------------------- Public types */

export interface CapabilityClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud?: string;
  /** Method names the token grants ("call:<method>" or just "<method>"). */
  readonly mth: readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly jti: string;
}

export interface CapabilityMintInput {
  /** Actor reference the capability is bound to. */
  readonly actor: { class: string; id: string };
  /** Method names this capability authorizes. */
  readonly methods: readonly string[];
  /** Time-to-live in milliseconds. */
  readonly ttlMs: number;
  /** Optional audience scope. */
  readonly audience?: string;
  /** Override the iat/exp anchor (tests). Default `Date.now()`. */
  readonly nowMs?: number;
}

export interface CapabilityVerifyOptions {
  /** Override `Date.now()` for replay tests. */
  readonly nowMs?: number;
  /** Optional revocation predicate; return true to reject the jti. */
  readonly isRevoked?: (jti: string) => boolean;
}

export class CapabilityError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

/* --------------------------------------------------- CapabilityIssuer */

export interface CapabilityIssuerOptions {
  /** Issuer string embedded as `iss`. */
  readonly issuer: string;
  /** Private signing key. If omitted, a fresh Ed25519 keypair is generated. */
  readonly privateKey?: KeyObject;
  /** Public verifying key (required if `privateKey` is supplied). */
  readonly publicKey?: KeyObject;
  /** Test seam: deterministic jti / nonces. */
  readonly nextJti?: () => string;
  /** Test seam: clock. */
  readonly nowMs?: () => number;
  /** Maximum allowed TTL in ms. Default 24h. */
  readonly maxTtlMs?: number;
}

export const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export class CapabilityIssuer {
  readonly issuer: string;
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private readonly nextJti: () => string;
  private readonly now: () => number;
  private readonly maxTtlMs: number;

  constructor(options: CapabilityIssuerOptions) {
    this.issuer = options.issuer;
    if (options.privateKey) {
      if (!options.publicKey) {
        throw new Error('CapabilityIssuer: publicKey is required when privateKey is supplied');
      }
      this.privateKey = options.privateKey;
      this.publicKey = options.publicKey;
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.nextJti = options.nextJti ?? (() => randomUUID());
    this.now = options.nowMs ?? Date.now;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  }

  /** Mint a fresh capability token. Returns the JWT string. */
  mint(input: CapabilityMintInput): string {
    if (input.ttlMs <= 0) {
      throw new CapabilityError('ttlMs must be positive', 'InvalidCapability');
    }
    if (input.ttlMs > this.maxTtlMs) {
      throw new CapabilityError(
        `ttlMs ${input.ttlMs} exceeds maximum ${this.maxTtlMs}`,
        'InvalidCapability',
      );
    }
    if (input.methods.length === 0) {
      throw new CapabilityError('methods must be non-empty', 'InvalidCapability');
    }
    const nowMs = input.nowMs ?? this.now();
    const exp = Math.floor((nowMs + input.ttlMs) / 1000);
    const sub = `${input.actor.class}:${input.actor.id}`;
    const claims: CapabilityClaims = {
      iss: this.issuer,
      sub,
      ...(input.audience ? { aud: input.audience } : {}),
      mth: [...input.methods],
      exp,
      jti: this.nextJti(),
    };
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const encodedHeader = b64uJson(header);
    const encodedPayload = b64uJson(claims);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const sig = nodeSign(null, Buffer.from(signingInput, 'utf8'), this.privateKey);
    return `${signingInput}.${b64uEncode(sig)}`;
  }
}

/* --------------------------------------------------- Verification */

export interface VerifiedCapability {
  readonly claims: CapabilityClaims;
  readonly token: string;
}

export function verifyCapability(
  token: string,
  publicKey: KeyObject,
  options: CapabilityVerifyOptions = {},
): VerifiedCapability {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new CapabilityError('malformed capability token', 'InvalidCapability');
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; typ?: string };
  let payload: CapabilityClaims;
  try {
    header = JSON.parse(b64uDecode(headerB64).toString('utf8')) as {
      alg?: string;
      typ?: string;
    };
    payload = JSON.parse(b64uDecode(payloadB64).toString('utf8')) as CapabilityClaims;
  } catch {
    throw new CapabilityError('capability token JSON malformed', 'InvalidCapability');
  }
  if (header.alg !== 'EdDSA') {
    throw new CapabilityError(
      `unsupported capability alg: ${String(header.alg)}`,
      'InvalidCapability',
    );
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = b64uDecode(sigB64);
  const ok = nodeVerify(null, Buffer.from(signingInput, 'utf8'), publicKey, sig);
  if (!ok) {
    throw new CapabilityError('capability signature invalid', 'InvalidCapability');
  }

  const nowMs = options.nowMs ?? Date.now();
  const expMs = payload.exp * 1000;
  if (nowMs >= expMs) {
    throw new CapabilityError('capability expired', 'CapabilityExpired');
  }
  if (payload.nbf !== undefined && nowMs < payload.nbf * 1000) {
    throw new CapabilityError('capability not yet valid', 'CapabilityNotYetValid');
  }
  if (options.isRevoked?.(payload.jti)) {
    throw new CapabilityError('capability revoked', 'CapabilityRevoked');
  }
  return { claims: payload, token };
}

/**
 * Read an `Authorization: Capability <jwt>` header and return the
 * raw token, or null if the header isn't present / doesn't use the
 * capability scheme.
 */
export function parseCapabilityHeader(headerValue: unknown): string | null {
  const v = typeof headerValue === 'string' ? headerValue : null;
  if (!v) return null;
  const m = /^Capability\s+(.+)$/i.exec(v);
  return m ? (m[1] ?? null) : null;
}

/**
 * True iff the capability's `mth` claim covers an attempted
 * `kind:'call'` action against `method`. Accepts both bare method
 * names (`"addItem"`) and the explicit `"call:addItem"` form.
 */
export function methodAllowed(claims: CapabilityClaims, method: string): boolean {
  return claims.mth.includes(method) || claims.mth.includes(`call:${method}`);
}

/**
 * True iff the capability's `sub` claim binds it to (class, id).
 */
export function subjectMatches(
  claims: CapabilityClaims,
  className: string,
  actorId: string,
): boolean {
  return claims.sub === `${className}:${actorId}`;
}

/* --------------------------------------------------- Encoders */

function b64uEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64uJson(value: unknown): string {
  return b64uEncode(Buffer.from(JSON.stringify(value), 'utf8'));
}

function b64uDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

/* --------------------------------------------------- Key helpers */

/**
 * Convenience: build an issuer from a private-key PEM string. The
 * matching public key is derived automatically.
 */
export function issuerFromPem(
  issuer: string,
  privateKeyPem: string,
  options: Omit<CapabilityIssuerOptions, 'issuer' | 'privateKey' | 'publicKey'> = {},
): CapabilityIssuer {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return new CapabilityIssuer({ issuer, privateKey, publicKey, ...options });
}
