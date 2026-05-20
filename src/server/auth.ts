/**
 * BYO authentication for the Fastify app.
 *
 * `buildApp({ auth, requireAuth? })` installs the hook that turns
 * each incoming request into a {@link Principal}. The framework
 * itself never talks to an IdP — operators wire `auth(req)` to
 * whatever they already use (JWT, HMAC, cookies, a database lookup).
 *
 * Behavior:
 *   - `auth` omitted              → every request gets `Principal.anonymous()`.
 *   - `auth` returns `null`       → request is `Principal.anonymous()` unless
 *                                    `requireAuth: true`, in which case 401.
 *   - `auth` returns a Principal  → `req.principal` is populated.
 *   - `auth` throws               → handled by `errors.ts` (default 500;
 *                                    throw `StatusError(..., 401)` for
 *                                    explicit auth-rejection responses).
 *
 * Built-in helpers (verifyJWT / verifyHmac / staticToken) live next
 * to the hook so they ship with the framework but stay opt-in.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as nodeVerify } from 'node:crypto';

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { StatusError } from '../error.js';

/* ---------------------------------------------------- Principal type */

export interface Principal {
  /** Stable subject identifier (e.g. user id, service name). */
  readonly sub: string;
  /** Role names; admin routes check for `'admin'` here. */
  readonly roles?: readonly string[];
  /** Tenant / org scope, when the deployment is multi-tenant. */
  readonly tenant?: string;
  /** Capability tokens (Phase 7b). */
  readonly capabilities?: readonly string[];
  /** Free-form claims forwarded from the verifier; opaque to actjs. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export const ANONYMOUS_SUB = 'anonymous';

export function anonymousPrincipal(): Principal {
  return { sub: ANONYMOUS_SUB, roles: [] };
}

export function isAnonymous(p: Principal): boolean {
  return p.sub === ANONYMOUS_SUB;
}

export function hasRole(p: Principal | undefined, role: string): boolean {
  return p?.roles?.includes(role) ?? false;
}

/* ---------------------------------------------------- Fastify wiring */

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook. Anonymous by default. */
    principal: Principal;
  }
}

export type AuthHook = (req: FastifyRequest) => Promise<Principal | null> | Principal | null;

export interface AuthHookOptions {
  readonly auth?: AuthHook;
  /** If true and `auth` returns null, respond 401. */
  readonly requireAuth?: boolean;
}

export function makeAuthHook(options: AuthHookOptions): preHandlerAsyncHookHandler {
  const { auth, requireAuth } = options;

  return async function authHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!auth) {
      req.principal = anonymousPrincipal();
      return;
    }
    let principal: Principal | null;
    try {
      principal = await auth(req);
    } catch (err) {
      if (err instanceof StatusError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthError(`auth hook threw: ${message}`);
    }
    if (principal === null || principal === undefined) {
      if (requireAuth) throw new AuthError('authentication required');
      req.principal = anonymousPrincipal();
      return;
    }
    req.principal = principal;
  };
}

export class AuthError extends StatusError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'Unauthorized';
  }
}

export class ForbiddenError extends StatusError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'Forbidden';
  }
}

/* ---------------------------------------------------- Built-in verifiers */

/**
 * Look up a bearer token in a static map. Useful for tests and local
 * dev; production setups should use {@link verifyJWT} or a real
 * `auth(req)` implementation.
 */
export function staticToken(tokens: Readonly<Record<string, Principal>>): AuthHook {
  return (req) => {
    const token = bearerToken(req);
    if (!token) return null;
    return tokens[token] ?? null;
  };
}

export interface VerifyHmacOptions {
  /** Header carrying the HMAC, default `x-actjs-signature`. */
  readonly header?: string;
  /** Header carrying the principal payload, default `x-actjs-principal`. */
  readonly payloadHeader?: string;
  /** Hash algorithm. Default `sha256`. */
  readonly algorithm?: string;
}

/**
 * Verify a JSON principal posted in `x-actjs-principal` (base64 of JSON)
 * and signed in `x-actjs-signature` (hex HMAC of the payload header
 * value). Anything more sophisticated (replay protection, timestamps,
 * nonces) is the operator's responsibility — supply a custom `auth`
 * hook for that.
 */
export function verifyHmac(secret: string, options: VerifyHmacOptions = {}): AuthHook {
  const header = options.header ?? 'x-actjs-signature';
  const payloadHeader = options.payloadHeader ?? 'x-actjs-principal';
  const algorithm = options.algorithm ?? 'sha256';
  return (req) => {
    const sig = headerString(req, header);
    const payload = headerString(req, payloadHeader);
    if (!sig || !payload) return null;
    const expected = createHmac(algorithm, secret).update(payload).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const raw = Buffer.from(payload, 'base64').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<Principal>;
      return materializePrincipal(parsed);
    } catch {
      return null;
    }
  };
}

export interface VerifyJwtOptions {
  /** JWKS URL — required for asymmetric verification. */
  readonly jwksUrl: string;
  /** Expected `iss` claim. Optional. */
  readonly issuer?: string;
  /** Expected `aud` claim. Optional. */
  readonly audience?: string;
  /** Override `Date.now()` for tests. */
  readonly now?: () => number;
  /** JWKS fetcher seam (defaults to `fetch`). */
  readonly fetchJwks?: (url: string) => Promise<JwksDocument>;
  /** Map a verified JWT payload to a Principal. Default extracts `sub`/`roles`/`tenant`/`scope`. */
  readonly principalFromClaims?: (claims: Record<string, unknown>) => Principal | null;
}

export interface JwksKey {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly x?: string;
  readonly y?: string;
  readonly crv?: string;
  readonly k?: string;
}

export interface JwksDocument {
  readonly keys: readonly JwksKey[];
}

/**
 * Bearer-JWT verifier. Resolves the signing key against the JWKS URL,
 * verifies the signature, then maps the claims to a Principal. JWT
 * signature verification is delegated to {@link verifyJwtSignature}
 * which the host can replace via the `verify` option for tests.
 */
export function verifyJWT(options: VerifyJwtOptions): AuthHook {
  const fetchJwks = options.fetchJwks ?? defaultJwksFetcher;
  const principalFromClaims = options.principalFromClaims ?? defaultPrincipalFromClaims;
  const now = options.now ?? Date.now;

  let cachedJwks: JwksDocument | null = null;
  let cachedAt = 0;
  const CACHE_TTL_MS = 5 * 60_000;

  return async (req) => {
    const token = bearerToken(req);
    if (!token) return null;
    if (!cachedJwks || now() - cachedAt > CACHE_TTL_MS) {
      cachedJwks = await fetchJwks(options.jwksUrl);
      cachedAt = now();
    }
    const verified = verifyJwtSignature(token, cachedJwks);
    if (!verified) return null;
    const claims = verified.payload;
    if (options.issuer && claims['iss'] !== options.issuer) return null;
    if (options.audience) {
      const aud = claims['aud'];
      if (
        aud !== options.audience &&
        !(Array.isArray(aud) && (aud as unknown[]).includes(options.audience))
      ) {
        return null;
      }
    }
    const exp = claims['exp'];
    if (typeof exp === 'number' && exp * 1000 < now()) return null;
    const nbf = claims['nbf'];
    if (typeof nbf === 'number' && nbf * 1000 > now()) return null;
    return principalFromClaims(claims);
  };
}

/* ---------------------------------------------------- Helpers */

function bearerToken(req: FastifyRequest): string | null {
  const auth = headerString(req, 'authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? (m[1] ?? null) : null;
}

function headerString(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

function materializePrincipal(raw: Partial<Principal>): Principal | null {
  if (typeof raw.sub !== 'string' || raw.sub.length === 0) return null;
  const out: { -readonly [K in keyof Principal]: Principal[K] } = { sub: raw.sub };
  if (Array.isArray(raw.roles)) out.roles = raw.roles.map((r) => String(r));
  if (typeof raw.tenant === 'string') out.tenant = raw.tenant;
  if (Array.isArray(raw.capabilities)) out.capabilities = raw.capabilities.map((c) => String(c));
  if (raw.claims && typeof raw.claims === 'object') out.claims = raw.claims;
  return out;
}

function defaultPrincipalFromClaims(claims: Record<string, unknown>): Principal | null {
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) return null;
  const out: { -readonly [K in keyof Principal]: Principal[K] } = { sub };
  const rolesRaw = claims['roles'] ?? extractScopes(claims['scope']);
  if (Array.isArray(rolesRaw)) out.roles = rolesRaw.map((r) => String(r));
  const tenant = claims['tenant'];
  if (typeof tenant === 'string') out.tenant = tenant;
  const capabilities = claims['capabilities'];
  if (Array.isArray(capabilities)) out.capabilities = capabilities.map((c) => String(c));
  out.claims = claims;
  return out;
}

function extractScopes(scope: unknown): string[] | undefined {
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  return undefined;
}

async function defaultJwksFetcher(url: string): Promise<JwksDocument> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return (await res.json()) as JwksDocument;
}

/**
 * Minimal JWT signature check. Handles `HS256` (shared secret carried
 * in `keys[].k` as base64url) and `none` (rejected). Asymmetric
 * algorithms (`RS256`/`ES256`) are accepted on the JWKS lookup but
 * the signature is checked against the platform `crypto.subtle`
 * API. Anything more exotic than these three families should plug
 * in their own `auth` hook.
 */
export function verifyJwtSignature(
  token: string,
  jwks: JwksDocument,
): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64uDecode(headerB64).toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(b64uDecode(payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const alg = header['alg'];
  if (alg === 'none' || typeof alg !== 'string') return null;

  const kid = header['kid'];
  const key = pickJwk(jwks, typeof kid === 'string' ? kid : undefined, alg);
  if (!key) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = b64uDecode(signatureB64);

  const ok = verifyWithJwk(alg, key, signingInput, signature);
  return ok ? { header, payload } : null;
}

function pickJwk(jwks: JwksDocument, kid: string | undefined, alg: string): JwksKey | null {
  if (kid) {
    const exact = jwks.keys.find((k) => k.kid === kid);
    if (exact) return exact;
  }
  return jwks.keys.find((k) => k.alg === alg) ?? jwks.keys[0] ?? null;
}

function verifyWithJwk(alg: string, jwk: JwksKey, data: Buffer, signature: Buffer): boolean {
  if (alg === 'HS256') {
    if (!jwk.k) return false;
    const secret = b64uDecode(jwk.k);
    const expected = createHmac('sha256', secret).update(data).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  if (alg === 'RS256') {
    try {
      // RSASSA-PKCS1-v1_5 with SHA-256. Node's crypto.verify reads the
      // digest from the algorithm name; the second arg is the data
      // to digest, NOT a precomputed digest.
      // Node's KeyObject type for JWKs uses the DOM `JsonWebKey`. We
      // pass the structurally-identical JwksKey through.
      const key = createPublicKey({
        key: jwk as Parameters<typeof createPublicKey>[0] extends { key: infer K } ? K : never,
        format: 'jwk',
      });
      return nodeVerify('RSA-SHA256', data, key, signature);
    } catch {
      return false;
    }
  }
  if (alg === 'ES256') {
    try {
      // Node's KeyObject type for JWKs uses the DOM `JsonWebKey`. We
      // pass the structurally-identical JwksKey through.
      const key = createPublicKey({
        key: jwk as Parameters<typeof createPublicKey>[0] extends { key: infer K } ? K : never,
        format: 'jwk',
      });
      // JOSE ECDSA signatures are raw r||s; Node expects DER. Convert.
      const der = joseEcdsaToDer(signature);
      return nodeVerify('SHA256', data, { key, dsaEncoding: 'der' }, der);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Convert a JOSE-encoded ECDSA P-256 signature (raw r||s, 64 bytes)
 * into ASN.1 DER for Node's crypto.verify.
 */
function joseEcdsaToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) {
    // Unexpected length; let the verify call fail downstream.
    return sig;
  }
  const r = trimLeadingZeros(sig.subarray(0, 32));
  const s = trimLeadingZeros(sig.subarray(32, 64));
  const rEncoded = encodeAsn1Integer(r);
  const sEncoded = encodeAsn1Integer(s);
  const seqBody = Buffer.concat([rEncoded, sEncoded]);
  return Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
}

function trimLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

function encodeAsn1Integer(buf: Buffer): Buffer {
  // ASN.1 INTEGER is signed; prepend 0x00 if the high bit is set so
  // it isn't interpreted as negative.
  const needsPad = (buf[0] ?? 0) & 0x80;
  const body = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

function b64uDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}
