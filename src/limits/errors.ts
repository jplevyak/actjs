/**
 * Errors raised by the limit subsystems.
 *
 * `RateLimitedError` maps to HTTP 429 with a `Retry-After` header.
 * `CapacityExhaustedError` maps to HTTP 503 `CapacityExhausted`.
 *
 * The mapping happens in `src/server/errors.ts`; both errors are
 * raised before the action touches the mailbox so the server can
 * give clients a precise reason to back off.
 */
export class RateLimitedError extends Error {
  readonly code = 'RateLimited';
  /** Suggested seconds-to-wait before retrying. */
  readonly retryAfterSeconds: number;
  /** Subject identifier (principal sub) we were limiting. */
  readonly subject: string;
  /** The bucket / operation the limit was attached to (e.g. `actor.call`). */
  readonly operation: string;

  constructor(message: string, subject: string, operation: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitedError';
    this.subject = subject;
    this.operation = operation;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class CapacityExhaustedError extends Error {
  readonly code = 'CapacityExhausted';
  /** Class name that hit the cap. */
  readonly className: string;
  /** Configured cap. */
  readonly cap: number;

  constructor(message: string, className: string, cap: number) {
    super(message);
    this.name = 'CapacityExhaustedError';
    this.className = className;
    this.cap = cap;
  }
}
