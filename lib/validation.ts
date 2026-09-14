import { z } from "zod";

const invalidUrl = (issue: { input?: unknown }) =>
  issue.input === undefined ? "`url` required." : "`url` invalid.";

/** Accept any HTTP(S) URL; network safety is checked after parsing. */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/, error: invalidUrl })
  .max(2048, { error: "`url` too long." });

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
