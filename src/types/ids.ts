/**
 * Branded primitive ids and version strings.
 *
 * The brand is purely structural — a `__brand` phantom property that
 * exists only at the type level. Use the `as*` helpers at every
 * boundary where untyped strings enter the system (JSON parses,
 * HTTP query strings, etc.) so the brand isn't silently lost.
 */
import { uuidv7 } from 'uuidv7';

export type ActorId = string & { readonly __brand: 'ActorId' };
export type ClassName = string & { readonly __brand: 'ClassName' };
export type Version = string & { readonly __brand: 'Version' };

/**
 * A class reference like "Cart@1.4.2".
 *
 * Template literal type, structurally a string. Construct via
 * `mkClassRef(name, version)` to keep the brand on inputs.
 */
export type ClassRef = `${string}@${string}` & { readonly __brand: 'ClassRef' };

export function asActorId(s: string): ActorId {
  return s as ActorId;
}

export function asClassName(s: string): ClassName {
  return s as ClassName;
}

export function asVersion(s: string): Version {
  return s as Version;
}

export function mkClassRef(name: ClassName, version: Version): ClassRef {
  return `${name as string}@${version as string}` as ClassRef;
}

/** Generate a fresh time-ordered ActorId (UUIDv7). */
export function mkActorId(): ActorId {
  return uuidv7() as ActorId;
}
