import { Fit, MAX_DIMENSION, OutputFormat } from "./validation";
import { readResponseBody } from "./remote";
import { MAX_RESPONSE_BYTES } from "./response";
import { PayloadTooLargeError, UnprocessableMediaError } from "./errors";
import { withDeadline } from "./timing";

export type ThumbnailSize = {
  width: number;
  height: number;
};

export type OutputOptions = {
  format: OutputFormat;
  quality: number;
  fit: Fit;
};

export const DEFAULT_OUTPUT: OutputOptions = {
  format: "jpeg",
  quality: 85,
  fit: "fill",
};

/** True when `fit` changes the result: both sides of the box are fixed. */
export const hasFixedBox = (size: ThumbnailSize) =>
  size.width !== -1 && size.height !== -1;

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// Source images may be larger than the output cap: a typical phone photo is
// 24-48 MP. MAX_IMAGE_BYTES still bounds the download, and this bounds the
// decoded bitmap (64 MP of RGBA is about 256 MB).
export const MAX_SOURCE_PIXELS = 8192 * 8192;

/** Translate Bun.Image decode failures into client-facing errors. */
const toImageError = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
    return new PayloadTooLargeError("Remote image dimensions are too large.");
  }
  if (code === "ERR_IMAGE_UNKNOWN_FORMAT" || code === "ERR_IMAGE_DECODE_FAILED") {
    return new UnprocessableMediaError("Unable to decode the remote image.", {
      cause: error,
    });
  }
  return error;
};

/** Set the encoder for the requested output format on a pipeline. */
const withEncoder = (image: Bun.Image, { format, quality }: OutputOptions) => {
  if (format === "png") return image.png();
  if (format === "webp") return image.webp({ quality });
  return image.jpeg({ quality, progressive: true });
};

const encode = async (
  image: Bun.Image,
  output: OutputOptions,
  deadlineAt: number
) => {
  const encoded = await withDeadline(
    withEncoder(image, output).buffer(),
    deadlineAt,
    "Image encoding timed out."
  ).catch((error) => {
    throw toImageError(error);
  });

  if (encoded.length > MAX_RESPONSE_BYTES) {
    throw new PayloadTooLargeError("Generated image is too large.");
  }
  return encoded;
};

/** Encode a frame FFmpeg has already sized and cropped. */
export const encodeFrame = (
  frame: Uint8Array,
  output: OutputOptions,
  deadlineAt = Date.now() + 30_000
) =>
  encode(
    new Bun.Image(frame, { maxPixels: MAX_DIMENSION * MAX_DIMENSION }),
    output,
    deadlineAt
  );

/**
 * Resize common raster images with Bun's native off-thread image pipeline.
 * `fit=cover` needs a crop, which Bun.Image lacks, so it goes through FFmpeg.
 */
export const generateImageThumbnail = async (
  response: Response,
  size: ThumbnailSize,
  output: OutputOptions = DEFAULT_OUTPUT,
  deadlineAt = Date.now() + 30_000
) => {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new PayloadTooLargeError("Remote image is too large.");
  }

  const source = await readResponseBody(response, MAX_IMAGE_BYTES, {
    timeoutMs: Math.max(1, deadlineAt - Date.now()),
  });

  const image = new Bun.Image(source, {
    autoOrient: true,
    maxPixels: MAX_SOURCE_PIXELS,
  });
  const { width: sourceWidth, height: sourceHeight } = await withDeadline(
    image.metadata(),
    deadlineAt,
    "Image metadata generation timed out."
  ).catch((error) => {
    throw toImageError(error);
  });

  const width =
    size.width === -1
      ? Math.max(1, Math.round((sourceWidth * size.height) / sourceHeight))
      : size.width;
  const height =
    size.height === -1
      ? Math.max(1, Math.round((sourceHeight * size.width) / sourceWidth))
      : size.height;

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new PayloadTooLargeError("Generated image dimensions are too large.");
  }

  const contain = output.fit === "contain" && hasFixedBox(size);
  return await encode(
    image.resize(width, height, contain ? { fit: "inside" } : undefined),
    output,
    deadlineAt
  );
};
