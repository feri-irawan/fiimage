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

/** The remote host could not be reached or answered with an unusable redirect. */
export class UpstreamRequestError extends Error {
  constructor(message = "Unable to reach the remote URL.", options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamRequestError";
  }
}

/** The remote URL returned a document rather than an image or video. */
export class UnsupportedMediaTypeError extends Error {
  constructor(message = "The remote URL is not an image or video.") {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}

/** The remote media was fetched but could not be turned into an image. */
export class UnprocessableMediaError extends Error {
  constructor(message = "Unable to decode the remote media.", options?: ErrorOptions) {
    super(message, options);
    this.name = "UnprocessableMediaError";
  }
}
