/**
 * Placeholder admin gate. Phase 5.3 replaces it with the BYO
 * `auth(req)` hook + role check; for now we accept any request
 * carrying `X-Actjs-Admin: 1`.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

const HEADER = 'x-actjs-admin';

export const adminOnly: preHandlerAsyncHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  if (req.headers[HEADER] === '1') return;
  await reply.code(403).header('content-type', 'application/problem+json').send({
    type: 'https://actjs.dev/errors/Forbidden',
    title: 'Forbidden',
    status: 403,
    code: 'Forbidden',
    detail: 'admin required (placeholder gate)',
  });
};
