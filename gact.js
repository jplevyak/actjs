// TODO
// * automatically load the code for a class from a known key:
//   /class/Actor -> Actor.js
// * store digest of files at a known key:
//   /class_sha256/Actor
//   and use to avoid reloading
import { randomUUID } from 'node:crypto';
import { StatusError } from './error.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export class Actor {
  constructor(gact, id) {
    if (!gact) throw new StatusError('bare Actor', 400);
    this.gact = gact;
    this.actor_id = id ?? randomUUID();
    gact.actors[this.actor_id] = this;
  }
}

export class Aggregate extends Actor {}

export class Replica extends Actor {
  constructor(gact, id) {
    super(gact, id);
    this.save_replica = true;
  }
}

export class GAct {
  constructor(tid, redisClient) {
    if (!redisClient) throw new StatusError('GAct requires a connected redis client', 500);
    this.tid = tid;
    this.Actor = Actor;
    this.Aggregate = Aggregate;
    this.Replica = Replica;
    this.redis = redisClient;
    this.max_retries = 5;
    this.actors = {};
    this.actors_json = {};
    this.aborted = false;
  }

  setActorPropertyById(o, v, id) {
    if (!o.actor_ids) o.actor_ids = {};
    o.actor_ids[v] = id;
    const self = this;
    Object.defineProperty(o, v, {
      configurable: true,
      enumerable: true,
      get() {
        return self.load(id).then((x) => {
          Object.defineProperty(o, v, {
            value: x,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          return x;
        });
      },
      set(x) {
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

  fixupForSave(o) {
    if (!(o instanceof Object)) return o;
    if (Array.isArray(o)) return o.map((v) => this.fixupForSave(v));
    const oo = {};
    for (const name of Object.keys(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
      // Skip lazy-load Actor getters (no resolved value yet).
      const desc = Object.getOwnPropertyDescriptor(o, name);
      if (!('value' in desc)) continue;
      const value = o[name];
      // Skip in-flight lazy loads.
      if (value instanceof Promise) continue;
      // Skip back-reference to the transaction.
      if (value instanceof GAct) continue;
      // Skip the replica-save sentinel.
      if (name === 'save_replica') continue;
      // Convert the lazy-load id map into actor references.
      if (name === 'actor_ids') {
        for (const key of Object.keys(value)) {
          oo[key] = { actor_id: value[key] };
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

  fixupFromLoad(o) {
    if (!(o instanceof Object)) return;
    if (o instanceof GAct) return;
    if (Array.isArray(o)) {
      for (const v of o) this.fixupFromLoad(v);
      return;
    }
    for (const name of Object.keys(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
      const v = o[name];
      if (v instanceof GAct) continue;
      if (v && typeof v === 'object' && typeof v.actor_id === 'string') {
        this.setActorPropertyById(o, name, v.actor_id);
      } else {
        this.fixupFromLoad(v);
      }
    }
  }

  async loadClass(name) {
    const classCode = await this.read(`${name}.js`);
    if (!classCode) throw new StatusError(`class source not found: ${name}.js`, 404);
    let result;
    try {
      const f = new AsyncFunction('gact', classCode);
      result = await f(this);
    } catch (err) {
      throw new StatusError(`class script error: ${err.message}`, 400);
    }
    if (typeof result !== 'function') return null;
    this[name] = result;
    return result;
  }

  async load(id) {
    const cached = this.actors[id];
    if (cached) return cached;
    await this.redis.watch(id);
    const json = await this.read(id);
    if (!json) return null;
    const a = JSON.parse(json);
    if (!a.actor_class) return null;
    if (!this[a.actor_class]) {
      const f = await this.loadClass(a.actor_class);
      if (!f) throw new StatusError(`cannot load class ${a.actor_class}`, 400);
    }
    Object.setPrototypeOf(a, this[a.actor_class].prototype);
    delete a.actor_class;
    a.actor_id = id;
    a.gact = this;
    this.fixupFromLoad(a);
    this.actors[id] = a;
    this.actors_json[id] = json;
    return a;
  }

  async save() {
    let any = false;
    const multi = this.redis.multi();
    for (const id of Object.keys(this.actors)) {
      const a = this.actors[id];
      if (a instanceof Replica && !a.save_replica) continue;
      a.actor_class = a.constructor.name;
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

  abort() {
    this.aborted = true;
  }

  async commit() {
    if (this.aborted) {
      await this.redis.unwatch();
      return true;
    }
    return this.save();
  }

  async read(id) {
    try {
      return await this.redis.get(id);
    } catch (err) {
      throw new StatusError(`redis read error: ${err.message}`, 500);
    }
  }

  async write(id, o) {
    try {
      return await this.redis.set(id, o);
    } catch (err) {
      throw new StatusError(`redis write error: ${err.message}`, 500);
    }
  }
}

export default GAct;
