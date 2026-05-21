/**
 * Actor REST routes:
 *   POST   /v1/actors/:class                — create (mints a fresh id)
 *   GET    /v1/actors/:class/:id            — snapshot
 *   POST   /v1/actors/:class/:id/:method    — invoke handler
 *   DELETE /v1/actors/:class/:id            — tombstone
 *
 * The create route doesn't materialize the actor; it just allocates
 * an id. The first `:method` call triggers `onInit` on the host.
 * Passing `onInit` args via the create body lands with a later phase
 * (the Runtime doesn't yet accept init args).
 */
import { z } from 'zod';

import { StatusError } from '../../error.js';
import type { Runtime } from '../../runtime/index.js';
import type { StorageDriver } from '../../storage/driver.js';
import { asActorId, asClassName, mkActorId } from '../../types/index.js';
import type { TypedFastifyInstance } from '../app.js';

const ClassParam = z.object({
  class: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid class name'),
});

const ActorParam = ClassParam.extend({
  id: z.string().min(1),
});

const MethodParam = ActorParam.extend({
  method: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid method name'),
});

const CreateResponse = z.object({
  class: z.string(),
  id: z.string(),
  manifest: z.string().optional(),
});

const SnapshotResponse = z.object({
  class: z.string(),
  id: z.string(),
  version: z.string(),
  seq: z.string(),
  state: z.unknown(),
});

const CallResponse = z.object({
  class: z.string(),
  id: z.string(),
  method: z.string(),
  result: z.unknown(),
  manifest: z.string().optional(),
});

const TombstoneResponse = z.object({
  class: z.string(),
  id: z.string(),
  tombstoned: z.literal(true),
});

const ActorBody = z.unknown();

export function registerActorRoutes(
  app: TypedFastifyInstance,
  driver: StorageDriver,
  runtime: Runtime,
): void {
  app.post(
    '/v1/actors/:class',
    {
      schema: {
        summary: 'Create an actor (mints a fresh id; onInit fires on first call)',
        tags: ['actors'],
        params: ClassParam,
        body: ActorBody,
        response: { 201: CreateResponse },
      },
    },
    async (req, reply) => {
      const className = asClassName(req.params.class);
      runtime.checkCreate(className, req.body ?? {}, req.principal);
      const id = mkActorId();
      const resp: { class: string; id: string; manifest?: string } = {
        class: req.params.class,
        id: id as string,
      };
      if (req.manifestPin) resp.manifest = req.manifestPin.sha;
      await reply.code(201).send(resp);
    },
  );

  app.get(
    '/v1/actors/:class/:id',
    {
      schema: {
        summary: 'Read the current snapshot of an actor',
        tags: ['actors'],
        params: ActorParam,
        response: { 200: SnapshotResponse },
      },
    },
    async (req) => {
      const id = asActorId(req.params.id);
      const snap = await driver.loadSnapshot(id);
      if (!snap) {
        const err = new StatusError(`no snapshot for actor ${id as string}`, 404);
        err.name = 'ActorNotFound';
        throw err;
      }
      // Class in URL should match the stored class.
      if ((snap.class as string) !== req.params.class) {
        throw new StatusError(
          `class mismatch: actor ${id as string} is ${snap.class as string}`,
          409,
        );
      }
      // Run a read-policy check against the current snapshot.
      await runtime.checkRead(asClassName(snap.class as string), id, req.principal);
      return {
        class: snap.class as string,
        id: id as string,
        version: snap.version as string,
        seq: snap.seq.toString(),
        state: snap.state,
      };
    },
  );

  app.post(
    '/v1/actors/:class/:id/:method',
    {
      schema: {
        summary: 'Invoke a handler on an actor',
        tags: ['actors'],
        params: MethodParam,
        body: ActorBody,
        response: { 200: CallResponse },
      },
    },
    async (req) => {
      const className = asClassName(req.params.class);
      const id = asActorId(req.params.id);
      const method = req.params.method;
      const result = await runtime.call(className, id, method, req.body ?? {}, req.principal);
      const resp: {
        class: string;
        id: string;
        method: string;
        result: unknown;
        manifest?: string;
      } = {
        class: req.params.class,
        id: id as string,
        method,
        result,
      };
      if (req.manifestPin) resp.manifest = req.manifestPin.sha;
      return resp;
    },
  );

  app.delete(
    '/v1/actors/:class/:id',
    {
      schema: {
        summary: 'Tombstone an actor',
        tags: ['actors'],
        params: ActorParam,
        response: { 200: TombstoneResponse },
      },
    },
    async (req) => {
      const id = asActorId(req.params.id);
      await runtime.tombstone(id, req.principal);
      return {
        class: req.params.class,
        id: id as string,
        tombstoned: true as const,
      };
    },
  );
}
