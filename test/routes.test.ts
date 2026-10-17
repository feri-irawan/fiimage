import { describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { capture } from "../lib/capture";
import { createOGImage } from "../lib/og";
import { generateThumbnail } from "../lib/thumbnail";
import { generationGate } from "../lib/concurrency";

const createResponse = () => {
  let statusCode = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      payload = value;
      return response;
    },
  } as unknown as Response;

  return {
    response,
    headers,
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
  };
};

describe("route contracts", () => {
  test("thumbnail rejects invalid query input with 400", async () => {
    const result = createResponse();

    await generateThumbnail(
      { query: { url: "file:///tmp/image.png" } } as unknown as Request,
      result.response
    );

    expect(result.statusCode).toBe(400);
    expect(result.payload).toHaveProperty("fieldErrors");
  });

  test("capture rejects unsafe URLs with 400", async () => {
    const result = createResponse();

    await capture(
      { query: { url: "http://127.0.0.1" } } as unknown as Request,
      result.response
    );

    expect(result.statusCode).toBe(400);
    expect(result.payload).toEqual({
      error: "Private network URLs are not allowed.",
    });
  });

  test("OG rejects unknown templates with 400", async () => {
    const result = createResponse();

    await createOGImage(
      {
        query: { url: "https://example.com", template: "9" },
      } as unknown as Request,
      result.response
    );

    expect(result.statusCode).toBe(400);
    expect(result.payload).toHaveProperty("fieldErrors");
  });

  test.each([
    ["thumbnail", generateThumbnail],
    ["capture", capture],
    ["OG", createOGImage],
  ] as const)("%s answers 429 with Retry-After when generation slots are full", async (_, handler) => {
    const releases = [generationGate.tryAcquire(), generationGate.tryAcquire()];
    try {
      expect(releases.every(Boolean)).toBe(true);
      const result = createResponse();

      await handler(
        { query: { url: "https://8.8.8.8/" } } as unknown as Request,
        result.response
      );

      expect(result.statusCode).toBe(429);
      expect(result.headers.get("Retry-After")).toBe("5");
    } finally {
      for (const release of releases) release?.();
    }
  });
});
