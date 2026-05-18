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
import { randomUUID, createHash } from 'node:crypto';

import semver from 'semver';
import ts from 'typescript';

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
  const diagnostics = parseTypeScript(sourceStr, input.name as string);
  if (diagnostics.length > 0) {
    throw new SyntaxInvalid(diagnostics);
  }
}

/** Run validation + storage write + audit. Returns the source sha256. */
export async function publishClass(
  driver: StorageDriver,
  input: PublishInput,
): Promise<{ sha256: string }> {
  validatePublish(input);

  const sourceBuf =
    typeof input.source === 'string' ? Buffer.from(input.source, 'utf8') : input.source;

  const storageInput: PublishClassInput = {
    name: input.name,
    version: input.version,
    source: sourceBuf,
    deps: input.deps ?? {},
    engines: input.engines ?? {},
    ...(input.floating !== undefined ? { floating: input.floating } : {}),
    ...(input.eventSourced !== undefined ? { eventSourced: input.eventSourced } : {}),
  };

  await driver.publishClass(storageInput);

  const sha = createHash('sha256').update(sourceBuf).digest('hex');

  await driver.appendAudit({
    id: randomUUID(),
    ts: Date.now(),
    principal: input.principal ?? 'system',
    action: 'class.published',
    target: `${input.name as string}@${input.version as string}`,
    meta: {
      sha256: sha,
      floating: input.floating ?? false,
      eventSourced: input.eventSourced ?? false,
    },
  });

  return { sha256: sha };
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
