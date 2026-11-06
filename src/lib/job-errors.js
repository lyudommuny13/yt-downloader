export class PermanentJobError extends Error {
  constructor(message, { cause, userMessage } = {}) {
    super(message, { cause });
    this.name = 'PermanentJobError';
    this.retryable = false;
    this.userMessage = userMessage;
  }
}

export function isPermanentJobError(error) {
  return error?.retryable === false;
}
