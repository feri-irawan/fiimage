import { describe, expect, test } from "bun:test";
import {
  captureSizeSchema,
  fitSchema,
  httpUrlSchema,
  outputFormatSchema,
  qualitySchema,
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

  test("defaults the output options to today's JPEG output", () => {
    expect(outputFormatSchema.parse(undefined)).toBe("jpeg");
    expect(qualitySchema.parse(undefined)).toBe(85);
    expect(fitSchema.parse(undefined)).toBe("fill");
  });

  test("accepts output formats, with jpg as an alias", () => {
    expect(outputFormatSchema.parse("png")).toBe("png");
    expect(outputFormatSchema.parse("webp")).toBe("webp");
    expect(outputFormatSchema.parse("jpg")).toBe("jpeg");
    expect(outputFormatSchema.safeParse("gif").success).toBe(false);
  });

  test.each(["0", "101", "50.5", "-1", "abc", ""])("rejects quality %p", (value) => {
    expect(qualitySchema.safeParse(value).success).toBe(false);
  });

  test("accepts quality from 1 to 100", () => {
    expect(qualitySchema.parse("1")).toBe(1);
    expect(qualitySchema.parse("100")).toBe(100);
  });

  test("accepts fit modes", () => {
    expect(fitSchema.parse("cover")).toBe("cover");
    expect(fitSchema.parse("contain")).toBe("contain");
    expect(fitSchema.safeParse("stretch").success).toBe(false);
  });
});
