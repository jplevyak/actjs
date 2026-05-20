/**
 * Admin gate built on the BYO `auth(req)` hook.
 *
 * `adminOnly` checks `req.principal.roles?.includes('admin')`. The
 * principal is populated by the auth preHandler (`makeAuthHook`).
 * Anonymous requests therefore can't see admin endpoints unless the
 * operator deliberately mints an anonymous principal with the
 * `admin` role.
 *
 * The legacy `X-Actjs-Admin: 1` header is also honored when no auth
 * hook is configured AND the server is running with
 * `NODE_ENV=development` or `ACTJS_DEV_ADMIN_HEADER=1`. This keeps
 * the existing `demo.bash` flow and the in-process test harness
 * working without each carrying a JWT.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { ForbiddenError, hasRole } from './auth.js';

const DEV_HEADER = 'x-actjs-admin';

function devAdminHeaderAllowed(): boolean {
  return process.env['NODE_ENV'] === 'development' || process.env['ACTJS_DEV_ADMIN_HEADER'] === '1';
}

export const adminOnly: preHandlerAsyncHookHandler = async (
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> => {
  if (hasRole(req.principal, 'admin')) return;
  if (devAdminHeaderAllowed() && req.headers[DEV_HEADER] === '1') return;
  throw new ForbiddenError('admin role required');
};

/** Shared header name for the dev admin shortcut. */
export const DEV_ADMIN_HEADER = DEV_HEADER;
