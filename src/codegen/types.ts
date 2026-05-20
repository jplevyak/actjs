/**
 * Shared types for the codegen pipeline.
 *
 * `actctl codegen` walks the published class catalog and produces
 * three artifacts: `index.d.ts`, `manifest.json`, `index.runtime.js`.
 * The intermediate representation is shared between the source
 * loader, the extractor, and the emitter so each piece can be
 * tested in isolation.
 */

export interface ExtractedHandler {
  readonly name: string;
  /** TS source text for the argument type (verbatim). `unknown` if missing. */
  readonly argsType: string;
  /** TS source text for the return type, unwrapped from any Promise<>. */
  readonly returnType: string;
  /** True if the handler's return type is `E[]` for an ES class. */
  readonly esEventReturn: boolean;
}

export interface ExtractedClass {
  readonly name: string;
  readonly version: string;
  /** sha256 of the raw source bytes — used as the per-class cache key. */
  readonly sourceSha256: string;
  readonly eventSourced: boolean;
  /** TS source text for the `State` type. `unknown` if not declared. */
  readonly stateType: string;
  /** ES only: TS source text for the event union. `never` for SWM. */
  readonly eventType: string;
  /** ES only: body of the `reduce` method, byte-identical to the source. */
  readonly reduceBody: string | null;
  /** ES only: reduce parameter names so the runtime can wire them. */
  readonly reduceParams: { state: string; event: string } | null;
  readonly handlers: readonly ExtractedHandler[];
  /** Diagnostics worth surfacing to the user. */
  readonly warnings: readonly string[];
}

export interface CodegenInput {
  readonly className: string;
  readonly version: string;
  readonly source: string;
}

export interface CodegenOutput {
  /** Generated `index.d.ts`. */
  readonly dts: string;
  /** Generated `manifest.json` body (already JSON-stringified, no trailing newline). */
  readonly manifestJson: string;
  /** Generated ES reducer runtime (`index.runtime.js`). */
  readonly runtimeJs: string;
  /** Manifest sha embedded in the .d.ts as `MANIFEST_SHA`. */
  readonly manifestSha: string;
  /** Per-class source sha map (file content addressing). */
  readonly perClassSha: ReadonlyMap<string, string>;
}

export interface CodegenManifestJson {
  readonly sha256: string;
  readonly resolved: Readonly<Record<string, string>>;
  /** Per-class source sha so consumers can verify byte-equivalence. */
  readonly sources: Readonly<Record<string, string>>;
}
