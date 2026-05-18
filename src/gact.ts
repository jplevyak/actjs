// TODO
// * automatically load the code for a class from a known key:
//   /class/Actor -> Actor.js
// * store digest of files at a known key:
//   /class_sha256/Actor
//   and use to avoid reloading
import { randomUUID } from 'node:crypto';

import { StatusError } from './error.js';

type Multi = {
  set(key: string, value: string): Multi;
  exec(): Promise<unknown[] | null>;
};

export interface RedisLike {
  watch(key: string): Promise<string>;
  unwatch(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  multi(): Multi;
}

type AsyncFn = (gact: GAct) => Promise<unknown>;
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => AsyncFn;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Actor {
  gact!: GAct;
  actor_id!: string;
  [key: string]: unknown;

  constructor(gact: GAct, id?: string) {
    if (!gact) throw new StatusError('bare Actor', 400);
    this.gact = gact;
    this.actor_id = id ?? randomUUID();
    gact.actors[this.actor_id] = this;
  }
}

export class Aggregate extends Actor {}

export class Replica extends Actor {
  constructor(gact: GAct, id?: string) {
    super(gact, id);
    (this as Replica).save_replica = true;
  }
}

export class GAct {
  readonly tid: number | string;
  readonly Actor = Actor;
  readonly Aggregate = Aggregate;
  readonly Replica = Replica;
  readonly redis: RedisLike;
  max_retries = 5;
  actors: Record<string, Actor> = {};
  actors_json: Record<string, string> = {};
  aborted = false;
  // Loaded class constructors are stored on the instance by name
  // (e.g. this['Beta']). Index signature allows that without losing the
  // typed fields above.
  [key: string]: unknown;

  constructor(tid: number | string, redisClient: RedisLike) {
    if (!redisClient) {
      throw new StatusError('GAct requires a connected redis client', 500);
    }
    this.tid = tid;
    this.redis = redisClient;
  }

  setActorPropertyById(o: Record<string, unknown>, v: string, id: string): void {
    const actorIds = (o.actor_ids ??= {} as Record<string, string>) as Record<string, string>;
    actorIds[v] = id;
    // Arrow callbacks capture this.gact lexically — Object.defineProperty's
    // get/set are never invoked with a different `this`, so the arrow form is
    // correct and avoids aliasing.
    Object.defineProperty(o, v, {
      configurable: true,
      enumerable: true,
      get: () =>
        this.load(id).then((x) => {
          Object.defineProperty(o, v, {
            value: x,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          return x;
        }),
      set: (x: unknown) => {
        Object.defineProperty(o, v, {
          value: x,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return x;
      },
    });
  }

  fixupForSave(o: unknown): unknown {
    if (!(o instanceof Object)) return o;
    if (Array.isArray(o)) return o.map((v) => this.fixupForSave(v));
    const oo: Record<string, unknown> = {};
    const src = o as Record<string, unknown>;
    for (const name of Object.keys(src)) {
      if (!Object.prototype.hasOwnProperty.call(src, name)) continue;
      // Skip lazy-load Actor getters (no resolved value yet).
      const desc = Object.getOwnPropertyDescriptor(src, name);
      if (!desc || !('value' in desc)) continue;
      const value = src[name];
      // Skip in-flight lazy loads.
      if (value instanceof Promise) continue;
      // Skip back-reference to the transaction.
      if (value instanceof GAct) continue;
      // Skip the replica-save sentinel.
      if (name === 'save_replica') continue;
      // Convert the lazy-load id map into actor references.
      if (name === 'actor_ids') {
        const ids = value as Record<string, string>;
        for (const key of Object.keys(ids)) {
          oo[key] = { actor_id: ids[key] };
        }
        continue;
      }
      // Convert resolved Actors into actor references.
      if (value instanceof Actor) {
        oo[name] = { actor_id: value.actor_id };
        continue;
      }
      oo[name] = this.fixupForSave(value);
    }
    return oo;
  }

  fixupFromLoad(o: unknown): void {
    if (!(o instanceof Object)) return;
    if (o instanceof GAct) return;
    if (Array.isArray(o)) {
      for (const v of o) this.fixupFromLoad(v);
      return;
    }
    const src = o as Record<string, unknown>;
    for (const name of Object.keys(src)) {
      if (!Object.prototype.hasOwnProperty.call(src, name)) continue;
      const v = src[name];
      if (v instanceof GAct) continue;
      if (
        v &&
        typeof v === 'object' &&
        typeof (v as { actor_id?: unknown }).actor_id === 'string'
      ) {
        this.setActorPropertyById(src, name, (v as { actor_id: string }).actor_id);
      } else {
        this.fixupFromLoad(v);
      }
    }
  }

  async loadClass(name: string): Promise<((...args: unknown[]) => unknown) | null> {
    const classCode = await this.read(`${name}.js`);
    if (!classCode) throw new StatusError(`class source not found: ${name}.js`, 404);
    let result: unknown;
    try {
      const f = new AsyncFunctionCtor('gact', classCode);
      result = await f(this);
    } catch (err) {
      throw new StatusError(`class script error: ${errMessage(err)}`, 400);
    }
    if (typeof result !== 'function') return null;
    const ctor = result as (...args: unknown[]) => unknown;
    this[name] = ctor;
    return ctor;
  }

  async load(id: string): Promise<Actor | null> {
    const cached = this.actors[id];
    if (cached) return cached;
    await this.redis.watch(id);
    const json = await this.read(id);
    if (!json) return null;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const actorClass = parsed.actor_class;
    if (typeof actorClass !== 'string') return null;
    if (!this[actorClass]) {
      const f = await this.loadClass(actorClass);
      if (!f) throw new StatusError(`cannot load class ${actorClass}`, 400);
    }
    const ctor = this[actorClass] as { prototype: object };
    Object.setPrototypeOf(parsed, ctor.prototype);
    delete parsed.actor_class;
    parsed.actor_id = id;
    parsed.gact = this;
    this.fixupFromLoad(parsed);
    const a = parsed as unknown as Actor;
    this.actors[id] = a;
    this.actors_json[id] = json;
    return a;
  }

  async save(): Promise<boolean> {
    let any = false;
    const multi = this.redis.multi();
    for (const id of Object.keys(this.actors)) {
      const a = this.actors[id]!;
      if (a instanceof Replica && !a.save_replica) continue;
      (a as Actor & { actor_class?: string }).actor_class = a.constructor.name;
      const aa = this.fixupForSave(a);
      const json = JSON.stringify(aa);
      if (json !== this.actors_json[id]) {
        any = true;
        multi.set(id, json);
      }
    }
    if (!any) {
      await this.redis.unwatch();
      return true;
    }
    // exec() resolves to null if any watched key changed since the WATCH.
    const result = await multi.exec();
    return result !== null;
  }

  abort(): void {
    this.aborted = true;
  }

  async commit(): Promise<boolean> {
    if (this.aborted) {
      await this.redis.unwatch();
      return true;
    }
    return this.save();
  }

  async read(id: string): Promise<string | null> {
    try {
      return await this.redis.get(id);
    } catch (err) {
      throw new StatusError(`redis read error: ${errMessage(err)}`, 500);
    }
  }

  async write(id: string, value: string): Promise<string | null> {
    try {
      return await this.redis.set(id, value);
    } catch (err) {
      throw new StatusError(`redis write error: ${errMessage(err)}`, 500);
    }
  }
}

export default GAct;
