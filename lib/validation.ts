import { z } from "zod";

const invalidUrl = (issue: { input?: unknown }) =>
  issue.input === undefined ? "`url` required." : "`url` invalid.";

/** Accept any HTTP(S) URL; network safety is checked after parsing. */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/, error: invalidUrl })
  .max(2048, { error: "`url` too long." });

/** An optional HTTP(S) image URL, such as `image` for the Photo template. */
export const imageUrlSchema = z
  .url({ protocol: /^https?$/, error: "`image` invalid." })
  .max(2048, { error: "`image` too long." })
  .optional();

export const MAX_DIMENSION = 4096;

const invalidSize = { error: "`size` invalid." };

export const captureSizeSchema = z
  .string(invalidSize)
  .regex(/^\d+x\d+$/, invalidSize)
  .default("640x480")
  .transform((value, ctx) => {
    const [rawWidth, rawHeight] = value.split("x");
    const width = Number(rawWidth);
    const height = Number(rawHeight);

    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      width > MAX_DIMENSION ||
      height < 1 ||
      height > MAX_DIMENSION
    ) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "`size` invalid.",
      });
      return z.NEVER;
    }

    return { width, height };
  });

export const thumbnailSizeSchema = z
  .string(invalidSize)
  .regex(/^(?:\?|[1-9]\d*)x(?:\?|[1-9]\d*)$/, invalidSize)
  .default("100x?")
  .transform((value, ctx) => {
    const [rawWidth, rawHeight] = value.split("x");

    if (rawWidth === "?" && rawHeight === "?") {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "`size` invalid.",
      });
      return z.NEVER;
    }

    const width = rawWidth === "?" ? -1 : Number(rawWidth);
    const height = rawHeight === "?" ? -1 : Number(rawHeight);

    if (
      (width !== -1 &&
        (!Number.isSafeInteger(width) ||
          width < 1 ||
          width > MAX_DIMENSION)) ||
      (height !== -1 &&
        (!Number.isSafeInteger(height) ||
          height < 1 ||
          height > MAX_DIMENSION))
    ) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "`size` invalid.",
      });
      return z.NEVER;
    }

    return { width, height };
  });

export const timestampSchema = z
  .string({ error: "`t` invalid." })
  .trim()
  .min(1, { error: "`t` invalid." })
  .regex(/^(?:\d+(?:\.\d+)?|\.\d+)$/, { error: "`t` invalid." })
  .transform(Number)
  .pipe(
    z
      .number()
      .finite()
      .nonnegative()
      .max(24 * 60 * 60, { error: "`t` invalid." })
  )
  .optional();

export const OUTPUT_FORMATS = ["jpeg", "png", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const invalidFormat = { error: "`f` invalid." };

export const OUTPUT_CONTENT_TYPES: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Output format, JPEG by default; `jpg` is accepted as an alias for `jpeg`. */
export const outputFormatSchema = z
  .enum([...OUTPUT_FORMATS, "jpg"], invalidFormat)
  .default("jpeg")
  .transform((format): OutputFormat => (format === "jpg" ? "jpeg" : format));

const invalidQuality = { error: "`q` invalid." };

/** JPEG and WebP quality from 1 to 100; PNG ignores it. */
export const qualitySchema = z
  .string(invalidQuality)
  .regex(/^\d{1,3}$/, invalidQuality)
  .default("85")
  .transform(Number)
  .pipe(z.number().int().min(1, invalidQuality).max(100, invalidQuality));

export const FITS = ["fill", "cover", "contain"] as const;
export type Fit = (typeof FITS)[number];

/**
 * How a fixed `s=WxH` box is filled: `fill` stretches, `cover` crops the
 * center, `contain` fits inside. Sizes with `?` always keep the aspect ratio.
 */
export const fitSchema = z.enum(FITS, { error: "`fit` invalid." }).default("fill");

/**
 * An on/off flag: `1`, `true`, or the bare name (`?fullPage`) turn it on;
 * `0`, `false`, or leaving it out keep it off.
 */
const flagSchema = (name: string) =>
  z
    .enum(["", "1", "true", "0", "false"], { error: `\`${name}\` invalid.` })
    .default("0")
    .transform((value) => value === "" || value === "1" || value === "true");

export const fullPageSchema = flagSchema("fullPage");
export const darkSchema = flagSchema("dark");

export const MAX_CAPTURE_DELAY_MS = 10_000;

const invalidDelay = { error: "`delay` invalid." };

/** Extra milliseconds to wait before a capture, from 0 to 10000. */
export const captureDelaySchema = z
  .string(invalidDelay)
  .regex(/^\d{1,5}$/, invalidDelay)
  .default("0")
  .transform(Number)
  .pipe(z.number().int().max(MAX_CAPTURE_DELAY_MS, invalidDelay));
