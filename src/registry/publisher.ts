/**
 * Class-version publisher.
 *
 * Validates a publish request and forwards it to the storage
 * driver. Validations:
 *   - `version` parses as semver.
 *   - dep keys are non-empty strings, values are valid semver
 *     ranges.
 *   - `engines.actjs` (if present) parses and is compatible with
 *     the server's own version.
 *   - TS source parses without syntax errors via the `typescript`
 *     compiler API.
 *
 * On success, calls `driver.publishClass` + `driver.appendAudit`.
 * Storage-level duplicates (same name+version) bubble up as the
 * `VersionAlreadyPublishedError` defined in Phase 2.
 */
import { createHash } from 'node:crypto';

import semver from 'semver';
import ts from 'typescript';

import { AUDIT_ACTIONS, Auditor } from '../audit/index.js';
import type { DepsMap, PublishClassInput, StorageDriver } from '../storage/driver.js';
import type { ClassName, Version } from '../types/index.js';

/** The actjs engine version this server identifies as. */
export const SERVER_ACTJS_VERSION = '0.3.0';

export interface PublishInput {
  readonly name: ClassName;
  readonly version: Version;
  /** TS source bytes (or string). */
  readonly source: string | Buffer;
  readonly deps?: DepsMap;
  readonly engines?: Readonly<Record<string, string>>;
  readonly floating?: boolean;
  readonly eventSourced?: boolean;
  /** Principal performing the publish. Surfaces in the audit log. */
  readonly principal?: string;
  /**
   * Optional signature attesting the publish. Verified against the
   * provided signing-key registry; the verified `kid` is recorded on
   * the class_version row as `signed_by` and forwarded to the audit
   * `class.signed` entry.
   */
  readonly signature?: { kid: string; signature: Buffer };
}

export interface PublishOptions {
  /** Auditor used to record `class.published` (+ `class.signed`). */
  readonly auditor?: Auditor;
  /** Signing-key registry used to verify `input.signature`. */
  readonly signingKeys?: import('./signing.js').SigningKeyVerifier;
  /** When true, an unsigned publish is rejected. */
  readonly requireSignedClasses?: boolean;
}

/* --------------------------------------------------------- Errors */

export class PublishError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

export class InvalidVersion extends PublishError {
  constructor(version: string) {
    super(`not a valid semver version: ${version}`, 'InvalidVersion');
  }
}

export class InvalidDepRange extends PublishError {
  constructor(depName: string, range: string) {
    super(`not a valid semver range for ${depName}: ${range}`, 'InvalidDepRange');
  }
}

export class IncompatibleEngine extends PublishError {
  constructor(required: string, actual: string) {
    super(`engines.actjs ${required} is incompatible with server ${actual}`, 'IncompatibleEngine');
  }
}

export class SyntaxInvalid extends PublishError {
  readonly diagnostics: readonly string[];
  constructor(diagnostics: readonly string[]) {
    super(`source has ${diagnostics.length} syntax error(s)`, 'SyntaxInvalid');
    this.diagnostics = diagnostics;
  }
}

export class ForbiddenImport extends PublishError {
  constructor(statement: string) {
    super(
      `published class source must be a function body — top-level import/export is not allowed: ${statement}`,
      'ForbiddenImport',
    );
  }
}

export class SignatureRequired extends PublishError {
  constructor() {
    super('requireSignedClasses is true; publish must include a signature', 'SignatureRequired');
  }
}

export class SignatureInvalid extends PublishError {
  constructor(reason: string) {
    super(`publish signature invalid: ${reason}`, 'SignatureInvalid');
  }
}

/* --------------------------------------------------- Implementation */

/** Validate a publish input. Throws on the first failure. */
export function validatePublish(input: PublishInput): void {
  if (!semver.valid(input.version as string)) {
    throw new InvalidVersion(input.version as string);
  }
  for (const [depName, depRange] of Object.entries(input.deps ?? {})) {
    if (!depName) throw new InvalidDepRange(depName, depRange);
    if (!semver.validRange(depRange)) {
      throw new InvalidDepRange(depName, depRange);
    }
  }
  const engineRange = input.engines?.['actjs'];
  if (engineRange !== undefined) {
    if (!semver.validRange(engineRange)) {
      throw new IncompatibleEngine(engineRange, SERVER_ACTJS_VERSION);
    }
    if (!semver.satisfies(SERVER_ACTJS_VERSION, engineRange)) {
      throw new IncompatibleEngine(engineRange, SERVER_ACTJS_VERSION);
    }
  }
  const sourceStr = typeof input.source === 'string' ? input.source : input.source.toString('utf8');
  const forbidden = findForbiddenImport(sourceStr);
  if (forbidden) throw new ForbiddenImport(forbidden);
  const diagnostics = parseTypeScript(sourceStr, input.name as string);
  if (diagnostics.length > 0) {
    throw new SyntaxInvalid(diagnostics);
  }
}

/**
 * Conservative regex check for top-level import/export statements.
 * Matches the obvious cases (`import X from ...`, `export class ...`,
 * etc.); the eventual AST-based pass (Phase 7.2) can tighten or
 * loosen as needed.
 */
function findForbiddenImport(source: string): string | null {
  // Strip line comments and block comments before scanning so commented-
  // out import lines don't trigger the gate.
  const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Multi-line: `import` or `export` as the first non-whitespace on a line.
  const pattern = /^[ \t]*(import|export)\b[^\n]*/m;
  const m = pattern.exec(stripped);
  return m ? m[0].trim() : null;
}

/** Run validation + storage write + audit. Returns the source sha256. */
export async function publishClass(
  driver: StorageDriver,
  input: PublishInput,
  options: PublishOptions = {},
): Promise<{ sha256: string; signedBy?: string }> {
  validatePublish(input);

  const sourceBuf =
    typeof input.source === 'string' ? Buffer.from(input.source, 'utf8') : input.source;

  const sha = createHash('sha256').update(sourceBuf).digest('hex');

  // Signing verification before the storage write. An unsigned-but-
  // required publish or a bad signature fails before we mutate state.
  let verifiedSignedBy: string | undefined;
  if (input.signature) {
    if (!options.signingKeys) {
      throw new SignatureInvalid('no signing-key registry configured on the server');
    }
    const ok = await options.signingKeys.verify({
      kid: input.signature.kid,
      signature: input.signature.signature,
      message: signingMessage(sha, input.name, input.version),
    });
    if (!ok.ok) throw new SignatureInvalid(ok.reason);
    verifiedSignedBy = input.signature.kid;
  } else if (options.requireSignedClasses) {
    throw new SignatureRequired();
  }

  const storageInput: PublishClassInput = {
    name: input.name,
    version: input.version,
    source: sourceBuf,
    deps: input.deps ?? {},
    engines: input.engines ?? {},
    ...(input.floating !== undefined ? { floating: input.floating } : {}),
    ...(input.eventSourced !== undefined ? { eventSourced: input.eventSourced } : {}),
    ...(input.signature && verifiedSignedBy
      ? { signature: { signedBy: verifiedSignedBy, signature: input.signature.signature } }
      : {}),
  };

  await driver.publishClass(storageInput);

  const auditor = options.auditor ?? new Auditor(driver, { mode: 'strict' });
  await auditor.record({
    action: AUDIT_ACTIONS.CLASS_PUBLISHED,
    target: `${input.name as string}@${input.version as string}`,
    principal: input.principal ?? 'system',
    meta: {
      sha256: sha,
      floating: input.floating ?? false,
      eventSourced: input.eventSourced ?? false,
      ...(verifiedSignedBy ? { signedBy: verifiedSignedBy } : {}),
    },
  });
  if (verifiedSignedBy) {
    await auditor.record({
      action: AUDIT_ACTIONS.CLASS_SIGNED,
      target: `${input.name as string}@${input.version as string}`,
      principal: input.principal ?? 'system',
      meta: { sha256: sha, kid: verifiedSignedBy },
    });
  }

  const out: { sha256: string; signedBy?: string } = { sha256: sha };
  if (verifiedSignedBy) out.signedBy = verifiedSignedBy;
  return out;
}

/**
 * Canonical signing payload: `sha256:<hex>|<name>@<version>`.
 *
 * The kid signs this message (not the source bytes directly) so a
 * verifier can recompute it from the published row's columns.
 */
export function signingMessage(sha256Hex: string, name: ClassName, version: Version): Buffer {
  return Buffer.from(`sha256:${sha256Hex}|${name as string}@${version as string}`, 'utf8');
}

/* -------------------------------------------- Source syntax check */

/**
 * Parse TS source and return any syntactic diagnostic messages.
 * Empty array means clean parse. We don't run the type checker —
 * that's the loader's job in Phase 4.2.
 */
function parseTypeScript(source: string, name: string): string[] {
  const filename = `${name}.ts`;
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  // `parseDiagnostics` is internal but stable; cast to access it.
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (!diagnostics || diagnostics.length === 0) return [];
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
