import { describe, expect, test } from "bun:test";
import {
  captureSizeSchema,
  httpUrlSchema,
  thumbnailSizeSchema,
  timestampSchema,
} from "../lib/validation";

describe("query validation", () => {
  test("parses fixed capture dimensions", () => {
    expect(captureSizeSchema.parse("1280x720")).toEqual({
      width: 1280,
      height: 720,
    });
  });

  test("accepts one automatic thumbnail dimension", () => {
    expect(thumbnailSizeSchema.parse("?x200")).toEqual({
      width: -1,
      height: 200,
    });
    expect(thumbnailSizeSchema.parse("100x?")).toEqual({
      width: 100,
      height: -1,
    });
  });

  test("rejects unsafe or invalid dimensions", () => {
    expect(captureSizeSchema.safeParse("0x720").success).toBe(false);
    expect(captureSizeSchema.safeParse("5000x720").success).toBe(false);
    expect(thumbnailSizeSchema.safeParse("?x?").success).toBe(false);
    expect(thumbnailSizeSchema.safeParse("100x0").success).toBe(false);
  });

  test("accepts finite non-negative timestamps only", () => {
    expect(timestampSchema.parse("5.25")).toBe(5.25);
    expect(timestampSchema.safeParse("-1").success).toBe(false);
    expect(timestampSchema.safeParse("Infinity").success).toBe(false);
    expect(timestampSchema.safeParse("86401").success).toBe(false);
  });

  test("accepts HTTP(S) URLs and rejects other protocols", () => {
    expect(httpUrlSchema.safeParse("https://example.com/image.png").success).toBe(
      true
    );
    expect(httpUrlSchema.safeParse("https://8.8.8.8/image.png").success).toBe(
      true
    );
    expect(httpUrlSchema.safeParse("file:///tmp/image.png").success).toBe(false);
  });
});
