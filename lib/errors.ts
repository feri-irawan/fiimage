export class PayloadTooLargeError extends Error {
  constructor(message = "The generated payload is too large.") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(message = "The request timed out.") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export class UpstreamResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UpstreamResponseError";
    this.status = status;
  }
}
