export class StatusError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'StatusError';
    this.status = status;
  }
}

export default StatusError;
