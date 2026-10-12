import { Request, Response } from "express";
import { z } from "zod";
import { sendGeneratedImage, sendTooManyRequests } from "./response";
import {
  fitSchema,
  httpUrlSchema,
  outputFormatSchema,
  qualitySchema,
  thumbnailSizeSchema,
  timestampSchema,
} from "./validation";
import { UnsafeHttpUrlError } from "./security";
import { generationGate } from "./concurrency";

const querySchema = z.object({
  url: httpUrlSchema,
  s: thumbnailSizeSchema,
  t: timestampSchema,
  f: outputFormatSchema,
  q: qualitySchema,
  fit: fitSchema,
});

const CONTENT_TYPES = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

/** Generate the thumbnail */
export const generateThumbnail = async (req: Request, res: Response) => {
  try {
    const { url, s, t, f, q, fit } = querySchema.parse(req.query);
    const release = generationGate.tryAcquire();
    if (!release) {
      sendTooManyRequests(res);
      return;
    }

    try {
      // Fetching and image/video dispatch live with the FFmpeg pipeline so
      // routes and tests share one code path.
      const { generateThumbnail: generateMediaThumbnail } = await import(
        "./ffmpeg"
      );
      const image = await generateMediaThumbnail(url, {
        size: s,
        seek: t,
        output: { format: f, quality: q, fit },
      });

      sendGeneratedImage(res, CONTENT_TYPES[f], image);
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
