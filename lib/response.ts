import { Response } from "express";
import { PayloadTooLargeError } from "./errors";

// Vercel Functions cap request and response bodies at 4.5 MB. Keep a margin
// below the platform limit so generated images are never rejected in transit.
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Set headers for deterministic generated images. */
export const setGeneratedImageHeaders = (res: Response, contentType: string) => {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
  );
  res.setHeader(
    "CDN-Cache-Control",
    "public, max-age=86400, stale-while-revalidate=604800"
  );
  res.setHeader(
    "Vercel-CDN-Cache-Control",
    "public, max-age=86400, stale-while-revalidate=604800"
  );
};

/** Send a generated image only when it fits the Vercel response envelope. */
export const sendGeneratedImage = (
  res: Response,
  contentType: string,
  image: Buffer
) => {
  if (image.length > MAX_RESPONSE_BYTES) {
    res
      .status(413)
      .json({ error: new PayloadTooLargeError("Generated image is too large.").message });
    return;
  }

  setGeneratedImageHeaders(res, contentType);
  res.send(image);
};
