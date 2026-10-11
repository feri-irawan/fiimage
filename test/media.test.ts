import { describe, expect, test } from "bun:test";
import ffmpegPath from "ffmpeg-static";
import { generateThumbnail } from "../lib/ffmpeg";
import {
  PayloadTooLargeError,
  UnprocessableMediaError,
  UnsupportedMediaTypeError,
} from "../lib/errors";

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

/** Render a test fixture with FFmpeg's synthetic `lavfi` sources. */
const createFixture = async (extension: string, args: string[]) => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable in the test runtime.");

  const path = `/tmp/fiimage-test-${crypto.randomUUID()}.${extension}`;
  const process = Bun.spawn({
    cmd: [ffmpegPath, "-hide_banner", "-loglevel", "error", "-y", ...args, path],
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Unable to create the ${extension} test fixture: ${stderr.trim()}`);
    }

    return await Bun.file(path).arrayBuffer();
  } finally {
    await Bun.file(path).delete().catch(() => undefined);
  }
};

const createTestMp4 = () =>
  createFixture("mp4", [
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
  ]);

const createTestJpeg = (width: number, height: number) =>
  createFixture("jpg", [
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=${width}x${height}`,
    "-frames:v",
    "1",
  ]);

const mockFetch = (body: BodyInit, contentType: string) =>
  (async () =>
    new Response(body, {
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;

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

  test("resizes photos larger than the output dimension cap", async () => {
    // 6000x4000 (24 MP) is a typical phone photo.
    const photo = await createTestJpeg(6000, 4000);

    const output = await generateThumbnail(
      "https://8.8.8.8/photo.jpg",
      { width: 300, height: -1 },
      undefined,
      mockFetch(photo, "image/jpeg")
    );
    const metadata = await new Bun.Image(output).metadata();

    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(200);
  }, 20_000);

  test("rejects images with too many source pixels with 413", async () => {
    const photo = await createTestJpeg(8200, 8200);

    await expect(
      generateThumbnail(
        "https://8.8.8.8/huge.jpg",
        { width: 100, height: -1 },
        undefined,
        mockFetch(photo, "image/jpeg")
      )
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  }, 20_000);

  test("rejects corrupt images with 422", async () => {
    await expect(
      generateThumbnail(
        "https://8.8.8.8/broken.png",
        { width: 100, height: -1 },
        undefined,
        mockFetch(png.subarray(0, 12), "image/png")
      )
    ).rejects.toBeInstanceOf(UnprocessableMediaError);
  });

  test("rejects web pages with 415 without running FFmpeg", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    const result = generateThumbnail(
      "https://8.8.8.8/page",
      { width: 100, height: -1 },
      undefined,
      mockFetch(body, "text/html; charset=utf-8")
    );

    await expect(result).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    await expect(result).rejects.toThrow("(text/html)");
    expect(cancelled).toBe(true);
  });

  test("rejects undecodable media with 422", async () => {
    await expect(
      generateThumbnail(
        "https://8.8.8.8/media",
        { width: 100, height: -1 },
        undefined,
        mockFetch("definitely not a video", "application/octet-stream")
      )
    ).rejects.toBeInstanceOf(UnprocessableMediaError);
  }, 10_000);

  test("rejects a timestamp past the end of the video with 422", async () => {
    const video = await createTestMp4();

    await expect(
      generateThumbnail(
        "https://8.8.8.8/media.mp4",
        { width: 16, height: -1 },
        60,
        mockFetch(video, "video/mp4")
      )
    ).rejects.toThrow("`t` is beyond the end of the media.");
  }, 20_000);
});
