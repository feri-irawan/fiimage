import express from "express";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import genThumbnail from "simple-thumbnail";
import createImage from "./lib/createImage.js";

const server = express();

// Membuat thumbnail
server.get("/", async (req, res) => {
  let { url, w, t } = req.query;

  if (!url) {
    res.status(403).send("Bad request");
    return;
  }

  try {
    await genThumbnail(url, res, w ? `${w}x?` : "100x?", {
      path: ffmpegPath.path,
      seek: t,
    });
  } catch (error) {}
});

// server.get("/create", createImage);

if (process.env.NODE_ENV === "development") server.listen(3000);

export default server;
