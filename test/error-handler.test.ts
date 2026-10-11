import { describe, expect, spyOn, test } from "bun:test";
import type { Request, Response } from "express";
import { TimeoutError } from "puppeteer-core";
import { toNavigationError } from "../lib/capture";
import { handleError } from "../lib/error-handler";
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  UnprocessableMediaError,
  UnsupportedMediaTypeError,
  UpstreamRequestError,
  UpstreamResponseError,
} from "../lib/errors";

const respondTo = (error: unknown) => {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      payload = value;
      return response;
    },
  } as unknown as Response;

  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    handleError(error, {} as Request, response, () => undefined);
  } finally {
    consoleError.mockRestore();
  }
  return { statusCode, payload };
};

describe("error responses", () => {
  test.each([
    [new PayloadTooLargeError(), 413],
    [new UnsupportedMediaTypeError(), 415],
    [new UnprocessableMediaError(), 422],
    [new UpstreamResponseError(404, "Unable to fetch media (HTTP 404)."), 502],
    [new UpstreamRequestError(), 502],
    [new RequestTimeoutError(), 504],
  ])("maps %p to HTTP %i", (error, status) => {
    const result = respondTo(error);

    expect(result.statusCode).toBe(status);
    expect(result.payload).toEqual({ error: error.message });
  });

  test("hides unexpected error details", () => {
    const result = respondTo(new Error("/tmp/secret-path exploded"));

    expect(result.statusCode).toBe(500);
    expect(result.payload).toEqual({ error: "Unable to generate the image." });
  });

  test("hides FFmpeg diagnostics behind the decode error message", () => {
    const error = new UnprocessableMediaError("Unable to decode the remote media.", {
      cause: new Error("FFmpeg exited with code 183. /tmp/fiimage-x.media: Invalid data"),
    });

    expect(respondTo(error).payload).toEqual({
      error: "Unable to decode the remote media.",
    });
  });
});

describe("capture navigation errors", () => {
  test("maps Puppeteer timeouts to gateway timeouts", () => {
    expect(
      toNavigationError(new TimeoutError("Navigation timeout of 15000 ms exceeded"))
    ).toBeInstanceOf(RequestTimeoutError);
  });

  test("maps Chromium network failures to upstream errors", () => {
    expect(
      toNavigationError(new Error("net::ERR_NAME_NOT_RESOLVED at https://example.invalid"))
    ).toBeInstanceOf(UpstreamRequestError);
  });

  test("leaves other errors unchanged", () => {
    const error = new Error("Protocol error");
    expect(toNavigationError(error)).toBe(error);
  });
});
