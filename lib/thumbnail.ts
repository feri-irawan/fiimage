import { Request, Response } from "express";
import { z } from "zod";
import { sendGeneratedImage } from "./response";
import {
  httpUrlSchema,
  thumbnailSizeSchema,
  timestampSchema,
} from "./validation";
import { UnsafeHttpUrlError } from "./security";
import { generationGate } from "./concurrency";

const querySchema = z.object({
  url: httpUrlSchema,
  s: thumbnailSizeSchema,
  t: timestampSchema,
});

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
      // Fetching and image/video dispatch live with the FFmpeg pipeline so
      // routes and tests share one code path.
      const { generateThumbnail: generateMediaThumbnail } = await import(
        "./ffmpeg"
      );
      const image = await generateMediaThumbnail(url, s, t);

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
