import { MAX_DIMENSION } from "./validation";
import { readResponseBody } from "./remote";
import { MAX_RESPONSE_BYTES } from "./response";
import { PayloadTooLargeError } from "./errors";
import { withDeadline } from "./timing";

export type ThumbnailSize = {
  width: number;
  height: number;
};

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

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
    maxPixels: MAX_DIMENSION * MAX_DIMENSION,
  });
  const { width: sourceWidth, height: sourceHeight } = await withDeadline(
    image.metadata(),
    deadlineAt,
    "Image metadata generation timed out."
  );

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
  );

  if (output.length > MAX_RESPONSE_BYTES) {
    throw new PayloadTooLargeError("Generated image is too large.");
  }
  return output;
};
