/**
 * RFC 7807 error mapping for the Fastify app.
 *
 * Every framework-recognized exception lands in one of these
 * problem-detail shapes. The SDK switches on the `code` field, not
 * on `status` or `title`, so adding a new error class doesn't
 * break clients that already handle the broader category.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { StatusError } from '../error.js';
import { CapacityExhaustedError, RateLimitedError } from '../limits/errors.js';
import { PolicyDeniedError } from '../policy/index.js';
import {
  DepConflict,
  ForbiddenImport,
  IncompatibleEngine,
  InvalidDepRange,
  InvalidVersion,
  PublishError,
  ResolverError,
  SyntaxInvalid,
} from '../registry/index.js';
import { ManifestRegression } from '../runtime/host.js';
import { ClassVersionExpired, CompileError, LoaderError } from '../runtime/loader.js';
import { MailboxFullError } from '../runtime/mailbox.js';
import { VersionAlreadyPublishedError } from '../storage/driver.js';

export interface ProblemDetail {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code: string;
  readonly [extra: string]: unknown;
}

export function problemDetailFor(err: unknown): ProblemDetail {
  // Fastify wraps validation errors in a FastifyError; check Zod first.
  if (err instanceof ZodError) {
    return {
      type: 'https://actjs.dev/errors/SchemaInvalid',
      title: 'Schema Invalid',
      status: 400,
      code: 'SchemaInvalid',
      detail: 'one or more request fields failed validation',
      issues: err.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
    };
  }

  if (err instanceof StatusError) {
    return {
      type: `https://actjs.dev/errors/${err.name}`,
      title: err.name,
      status: err.status,
      detail: err.message,
      code: err.name,
    };
  }

  if (err instanceof VersionAlreadyPublishedError) {
    return wrap(err, 409, 'VersionAlreadyPublished');
  }
  if (err instanceof SyntaxInvalid) {
    return wrap(err, 400, 'SyntaxInvalid', { diagnostics: err.diagnostics });
  }
  if (err instanceof ForbiddenImport) {
    return wrap(err, 400, 'ForbiddenImport');
  }
  if (
    err instanceof InvalidVersion ||
    err instanceof InvalidDepRange ||
    err instanceof IncompatibleEngine
  ) {
    return wrap(err, 400, err.code);
  }
  if (err instanceof PublishError) {
    return wrap(err, 400, err.code);
  }

  if (err instanceof DepConflict) {
    return wrap(err, 409, 'DepConflict', {
      class: err.className,
      ranges: err.accumulatedRanges,
    });
  }
  if (err instanceof ResolverError) {
    return wrap(err, 400, err.code);
  }

  if (err instanceof MailboxFullError) {
    return wrap(err, 429, 'MailboxFull');
  }
  if (err instanceof RateLimitedError) {
    return wrap(err, 429, 'RateLimited', {
      retryAfter: err.retryAfterSeconds,
      subject: err.subject,
      operation: err.operation,
    });
  }
  if (err instanceof CapacityExhaustedError) {
    return wrap(err, 503, 'CapacityExhausted', {
      class: err.className,
      cap: err.cap,
    });
  }
  if (err instanceof PolicyDeniedError) {
    return wrap(err, 403, 'PolicyDenied', { reason: err.reason });
  }
  if (err instanceof ManifestRegression) {
    return wrap(err, 409, 'ManifestRegression', {
      persistedVersion: err.persistedVersion,
      registeredVersion: err.registeredVersion,
    });
  }

  if (err instanceof ClassVersionExpired) {
    return wrap(err, 410, 'Gone');
  }
  if (err instanceof CompileError) {
    return wrap(err, 500, 'CompileError', { diagnostics: err.diagnostics });
  }
  if (err instanceof LoaderError) {
    return wrap(err, 500, err.code);
  }

  // FastifyError-style validation passthrough.
  const maybeFastify = err as FastifyError;
  if (maybeFastify?.validation && Array.isArray(maybeFastify.validation)) {
    return {
      type: 'https://actjs.dev/errors/SchemaInvalid',
      title: 'Schema Invalid',
      status: maybeFastify.statusCode ?? 400,
      code: 'SchemaInvalid',
      detail: maybeFastify.message,
      issues: maybeFastify.validation,
    };
  }

  // Unknown error: 500 with a sanitized message.
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'https://actjs.dev/errors/InternalError',
    title: 'Internal Error',
    status: 500,
    code: 'InternalError',
    detail: message,
  };
}

function wrap(
  err: Error,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): ProblemDetail {
  return {
    type: `https://actjs.dev/errors/${code}`,
    title: err.name,
    status,
    detail: err.message,
    code,
    ...extra,
  };
}

/** Install on the Fastify instance via `app.setErrorHandler(handleError)`. */
export async function handleError(
  err: unknown,
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const problem = problemDetailFor(err);
  let rep = reply.code(problem.status).header('content-type', 'application/problem+json');
  if (err instanceof RateLimitedError) {
    rep = rep.header('Retry-After', String(err.retryAfterSeconds));
  }
  await rep.send(problem);
}
