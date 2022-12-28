import express from "express";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import genThumbnail from "simple-thumbnail";

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

if (process.env.NODE_ENV === "development") server.listen(3000);

export default server;
