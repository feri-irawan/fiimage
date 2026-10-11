import { MAX_DIMENSION } from "./validation";
import { readResponseBody } from "./remote";
import { MAX_RESPONSE_BYTES } from "./response";
import { PayloadTooLargeError, UnprocessableMediaError } from "./errors";
import { withDeadline } from "./timing";

export type ThumbnailSize = {
  width: number;
  height: number;
};

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// Source images may be larger than the output cap: a typical phone photo is
// 24-48 MP. MAX_IMAGE_BYTES still bounds the download, and this bounds the
// decoded bitmap (64 MP of RGBA is about 256 MB).
const MAX_SOURCE_PIXELS = 8192 * 8192;

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

/** Resize common raster images with Bun's native off-thread image pipeline. */
export const generateImageThumbnail = async (
  response: Response,
  size: ThumbnailSize,
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

  const output = await withDeadline(
    image
      .resize(width, height)
      .jpeg({ quality: 85, progressive: true })
      .buffer(),
    deadlineAt,
    "Image encoding timed out."
  ).catch((error) => {
    throw toImageError(error);
  });

  if (output.length > MAX_RESPONSE_BYTES) {
    throw new PayloadTooLargeError("Generated image is too large.");
  }
  return output;
};
