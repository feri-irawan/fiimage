import { Request, Response } from "express";
import { z } from "zod";
import { fetchSafeResponse } from "./remote";
import { sendGeneratedImage } from "./response";
import {
  httpUrlSchema,
  thumbnailSizeSchema,
  timestampSchema,
} from "./validation";
import { UnsafeHttpUrlError } from "./security";
import { generationGate } from "./concurrency";
import { UpstreamResponseError } from "./errors";

const querySchema = z.object({
  url: httpUrlSchema,
  s: thumbnailSizeSchema,
  t: timestampSchema,
});

const REQUEST_TIMEOUT_MS = 50_000;

/** Generate the thumbnail */
export const generateThumbnail = async (req: Request, res: Response) => {
  try {
    const { url, s, t } = querySchema.parse(req.query);
    const release = generationGate.tryAcquire();
    if (!release) {
      res.status(429).json({ error: "Too many image generations are in progress." });
      return;
    }

    try {
      const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
      const response = await fetchSafeResponse(url, {
        headers: { Accept: "image/*,video/*,*/*;q=0.8" },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamResponseError(
          response.status,
          `Unable to fetch media (HTTP ${response.status}).`
        );
      }

      const contentType = (response.headers.get("content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      const image = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/bmp",
      ].includes(contentType)
        ? await (await import("./image")).generateImageThumbnail(
            response,
            s,
            deadlineAt
          )
        : await (await import("./ffmpeg")).generateVideoThumbnail(
            response,
            s,
            t,
            deadlineAt
          );

      sendGeneratedImage(res, "image/jpeg", image);
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(z.prettifyError(error));
      res.status(400).json(z.flattenError(error));
      return;
    }
    if (error instanceof UnsafeHttpUrlError) {
      res.status(400).json({ error: error.message });
      return;
    }

    throw error;
  }
};
