import express from "express";
import { handleError } from "./lib/error-handler";

const server = express();

/**
 * Resize an image or generate a video thumbnail.
 * Query: `url`, optional `s` size, and optional `t` video timestamp.
 * The FFmpeg handler is loaded on demand to keep unrelated dependencies out
 * of this endpoint's cold start.
 */
server.get("/", async (req, res, next) => {
  try {
    const { generateThumbnail } = await import("./lib/thumbnail");
    await generateThumbnail(req, res);
  } catch (error) {
    next(error);
  }
});

/** Capture a web page as a PNG. Query: `url` and optional `s` viewport size. */
server.get("/capture", async (req, res, next) => {
  try {
    const { capture } = await import("./lib/capture");
    await capture(req, res);
  } catch (error) {
    next(error);
  }
});

/** Generate a 1200x630 Open Graph image. Query: `url` and optional `template`. */
server.get("/og", async (req, res, next) => {
  try {
    const { createOGImage } = await import("./lib/og");
    await createOGImage(req, res);
  } catch (error) {
    next(error);
  }
});

server.use(handleError);

export default server;
