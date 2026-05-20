/**
 * Public entrypoints for the codegen pipeline.
 *
 * The `actctl` CLI uses these; consumers wiring codegen into their
 * own build can import from `actjs/codegen` directly.
 */
export { run, type RunOptions, type RunResult } from './run.js';
export { emit } from './emit.js';
export { extractClass } from './extract.js';
export {
  localLoader,
  httpLoader,
  HttpLoaderError,
  type SourceLoader,
  type Target,
} from './sources.js';
export { Cache } from './cache.js';
export { unifiedDiff } from './diff.js';
export type {
  CodegenInput,
  CodegenOutput,
  CodegenManifestJson,
  ExtractedClass,
  ExtractedHandler,
} from './types.js';
