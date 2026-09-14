import { describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { capture } from "../lib/capture";
import { createOGImage } from "../lib/og";
import { generateThumbnail } from "../lib/thumbnail";

const createResponse = () => {
  let statusCode = 200;
  let payload: unknown;
  const response = {
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
        query: { url: "https://example.com", template: "2" },
      } as unknown as Request,
      result.response
    );

    expect(result.statusCode).toBe(400);
    expect(result.payload).toHaveProperty("fieldErrors");
  });
});
