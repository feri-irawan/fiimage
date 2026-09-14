import { describe, expect, test } from "bun:test";
import ffmpegPath from "ffmpeg-static";
import { generateThumbnail } from "../lib/ffmpeg";

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
);

const mockRasterFetch = (contentType: string) =>
  (async () =>
    new Response(png, {
      headers: {
        "content-length": String(png.byteLength),
        "content-type": contentType,
      },
    })) as unknown as typeof fetch;

const createTestMp4 = async () => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable in the test runtime.");

  const path = `/tmp/fiimage-test-${crypto.randomUUID()}.mp4`;
  const process = Bun.spawn({
    cmd: [
      ffmpegPath,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:r=2:d=1",
      "-an",
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      path,
    ],
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Unable to create the MP4 test fixture: ${stderr.trim()}`);
    }

    return await Bun.file(path).arrayBuffer();
  } finally {
    await Bun.file(path).delete().catch(() => undefined);
  }
};

describe("thumbnail generation", () => {
  test("uses Bun.Image for raster image responses", async () => {
    const output = await generateThumbnail(
      "https://8.8.8.8/image.png",
      { width: 2, height: -1 },
      undefined,
      mockRasterFetch("image/png")
    );
    const metadata = await new Bun.Image(output).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
  });

  test("uses the non-shell FFmpeg path for other media", async () => {
    const output = await generateThumbnail(
      "https://8.8.8.8/media",
      { width: -1, height: 2 },
      undefined,
      (async () =>
        new Response(png, {
          headers: {
            "content-length": String(png.byteLength),
            "content-type": "application/octet-stream",
          },
        })) as unknown as typeof fetch
    );

    expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 10_000);

  test("supports MP4 files that are not streamable over stdin", async () => {
    const video = await createTestMp4();

    const output = await generateThumbnail(
      "https://8.8.8.8/media.mp4",
      { width: 16, height: -1 },
      0.5,
      (async () =>
        new Response(video, {
          headers: {
            "content-length": String(video.byteLength),
            "content-type": "video/mp4",
          },
        })) as unknown as typeof fetch
    );

    expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 20_000);
});
