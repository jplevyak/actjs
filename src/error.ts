export class StatusError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'StatusError';
    this.status = status;
  }
}

export default StatusError;
