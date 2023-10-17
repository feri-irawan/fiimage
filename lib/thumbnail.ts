import genThumbnail from "simple-thumbnail";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { Request, Response } from "express";
import { z } from "zod";

const querySchema = z.object({
  /** Image URL */
  url: z
    .string({ required_error: "`url` required." })
    .url({ message: "`url` invalid." }),

  /** Image size */
  s: z
    .string()
    .default("100x?")
    .refine((size) => size.includes("x"), { message: "`size` invalid." }),

  /** Seek time */
  t: z.coerce.number().optional(),
});

/** Generate the thumbnail */
export const generateThumbnail = async (req: Request, res: Response) => {
  try {
    const { url, s, t } = querySchema.parse(req.query);

    await genThumbnail(url, res, s, {
      path: ffmpegPath.path,
      seek: t,
    });
  } catch (error) {
    console.log(error);

    if (error instanceof z.ZodError) {
      res.status(500).send(JSON.parse(error.message));
      return;
    }

    throw error;
  }
};
