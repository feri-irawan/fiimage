import { describe, expect, test } from "bun:test";
import type { Response } from "express";
import { MAX_RESPONSE_BYTES, sendGeneratedImage } from "../lib/response";

const createResponse = () => {
  let statusCode = 200;
  const headers = new Map<string, string>();
  let body: Buffer | undefined;

  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = Buffer.from(JSON.stringify(value));
      return response;
    },
    send(value: Buffer) {
      body = value;
      return response;
    },
  } as unknown as Response;

  return { response, headers, get statusCode() { return statusCode; }, get body() { return body; } };
};

describe("generated image responses", () => {
  test("rejects payloads above the Vercel-safe limit", () => {
    const result = createResponse();

    sendGeneratedImage(
      result.response,
      "image/png",
      Buffer.alloc(MAX_RESPONSE_BYTES + 1)
    );

    expect(result.statusCode).toBe(413);
    expect(result.body?.toString()).toContain("Generated image is too large.");
    expect(result.headers.has("Content-Type")).toBe(false);
  });

  test("sets cache headers for successful images", () => {
    const result = createResponse();
    const image = Buffer.from([1, 2, 3]);

    sendGeneratedImage(result.response, "image/png", image);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(image);
    expect(result.headers.get("Content-Type")).toBe("image/png");
    expect(result.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });
});
