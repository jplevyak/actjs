/**
 * Snapshot encoding & decoding.
 *
 * gzip via `node:zlib`. Built in, fast enough, no native deps. The
 * threshold metric makes the moment a class needs S3 storage visible.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

/** Threshold above which we emit a warning metric (Phase 8). */
export const SNAPSHOT_SIZE_WARN_BYTES = 64 * 1024;

export function encodeSnapshot(state: unknown): Buffer {
  const json = JSON.stringify(state);
  return gzipSync(Buffer.from(json, 'utf8'));
}

export function decodeSnapshot<S = unknown>(bytes: Buffer): S {
  const json = gunzipSync(bytes).toString('utf8');
  return JSON.parse(json) as S;
}

export function isOversizedSnapshot(bytes: Buffer): boolean {
  return bytes.byteLength > SNAPSHOT_SIZE_WARN_BYTES;
}
