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
      { size: { width: 2, height: -1 } },
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
      { size: { width: -1, height: 2 } },
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
      { size: { width: 16, height: -1 }, seek: 0.5 },
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
      { size: { width: 300, height: -1 } },
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
        { size: { width: 100, height: -1 } },
        mockFetch(photo, "image/jpeg")
      )
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  }, 20_000);

  test("rejects corrupt images with 422", async () => {
    await expect(
      generateThumbnail(
        "https://8.8.8.8/broken.png",
        { size: { width: 100, height: -1 } },
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
      { size: { width: 100, height: -1 } },
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
        { size: { width: 100, height: -1 } },
        mockFetch("definitely not a video", "application/octet-stream")
      )
    ).rejects.toBeInstanceOf(UnprocessableMediaError);
  }, 10_000);

  test("rejects a timestamp past the end of the video with 422", async () => {
    const video = await createTestMp4();

    await expect(
      generateThumbnail(
        "https://8.8.8.8/media.mp4",
        { size: { width: 16, height: -1 }, seek: 60 },
        mockFetch(video, "video/mp4")
      )
    ).rejects.toThrow("`t` is beyond the end of the media.");
  }, 20_000);
});

/** Decode any image FFmpeg can read into RGBA pixels. */
const readPixels = async (image: Uint8Array) => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable in the test runtime.");
  const process = Bun.spawn({
    cmd: [ffmpegPath, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    stdin: new Blob([Uint8Array.from(image)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [pixels, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error("Unable to decode the test output.");
  const { width } = await new Bun.Image(image).metadata();
  return (x: number, y: number) => Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
};

const isGreen = ([red, green, blue]: number[]) => green > 200 && red < 60 && blue < 60;

// Three 10px bands: red | green | blue.
const createBandedPng = () =>
  createFixture("png", [
    "-filter_complex",
    "color=c=red:s=10x10[a];color=c=lime:s=10x10[b];color=c=blue:s=10x10[c];[a][b][c]hstack=inputs=3",
    "-frames:v",
    "1",
  ]);

describe("output options", () => {
  const thumbnail = (body: BodyInit, contentType: string, options: Parameters<typeof generateThumbnail>[1]) =>
    generateThumbnail("https://8.8.8.8/media", options, mockFetch(body, contentType));

  test.each(["jpeg", "png", "webp"] as const)("encodes images as %s", async (format) => {
    const photo = await createTestJpeg(64, 32);

    const output = await thumbnail(photo, "image/jpeg", {
      size: { width: 32, height: -1 },
      output: { format, quality: 85, fit: "fill" },
    });
    const metadata = await new Bun.Image(output).metadata();

    expect(metadata.format).toBe(format);
    expect([metadata.width, metadata.height]).toEqual([32, 16]);
  });

  test("uses the quality for JPEG and WebP", async () => {
    const noisy = await createFixture("png", ["-f", "lavfi", "-i", "testsrc2=s=256x256", "-frames:v", "1"]);
    const encode = (format: "jpeg" | "webp", quality: number) =>
      thumbnail(noisy, "image/png", {
        size: { width: 256, height: -1 },
        output: { format, quality, fit: "fill" },
      });

    for (const format of ["jpeg", "webp"] as const) {
      const [low, high] = await Promise.all([encode(format, 10), encode(format, 95)]);
      expect(low.length).toBeLessThan(high.length);
    }
  });

  test("fill stretches to the box and contain fits inside it", async () => {
    const wide = await createTestJpeg(40, 20);
    const size = { width: 10, height: 10 };

    const filled = await thumbnail(wide, "image/jpeg", {
      size,
      output: { format: "png", quality: 85, fit: "fill" },
    });
    const contained = await thumbnail(wide, "image/jpeg", {
      size,
      output: { format: "png", quality: 85, fit: "contain" },
    });
    const filledSize = await new Bun.Image(filled).metadata();
    const containedSize = await new Bun.Image(contained).metadata();

    expect([filledSize.width, filledSize.height]).toEqual([10, 10]);
    expect([containedSize.width, containedSize.height]).toEqual([10, 5]);
  });

  test("cover fills the box and crops the center of an image", async () => {
    const banded = await createBandedPng();

    const output = await thumbnail(banded, "image/png", {
      size: { width: 10, height: 10 },
      // `t` has no meaning for a still image and must not break the crop.
      seek: 5,
      output: { format: "png", quality: 85, fit: "cover" },
    });
    const metadata = await new Bun.Image(output).metadata();
    const pixel = await readPixels(output);

    expect([metadata.width, metadata.height]).toEqual([10, 10]);
    // Only the green middle band remains, edge to edge.
    expect(isGreen(pixel(0, 5))).toBe(true);
    expect(isGreen(pixel(5, 5))).toBe(true);
    expect(isGreen(pixel(9, 5))).toBe(true);
  }, 20_000);

  test.each(["fill", "cover"] as const)("keeps transparency in PNG output (fit=%s)", async (fit) => {
    const transparent = await createFixture("png", [
      "-f", "lavfi", "-i", "color=c=red@0.0:s=20x20,format=rgba", "-frames:v", "1",
    ]);

    const output = await thumbnail(transparent, "image/png", {
      size: { width: 10, height: 10 },
      output: { format: "png", quality: 85, fit },
    });
    const pixel = await readPixels(output);

    expect(pixel(5, 5)[3]).toBe(0);
  }, 20_000);

  test("rejects images with too many pixels on the cover path with 413", async () => {
    const huge = await createTestJpeg(8200, 8200);

    await expect(
      thumbnail(huge, "image/jpeg", {
        size: { width: 100, height: 100 },
        output: { format: "jpeg", quality: 85, fit: "cover" },
      })
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  }, 20_000);

  test("applies cover and contain to video frames in any format", async () => {
    const video = await createTestMp4();
    const frame = (fit: "cover" | "contain") =>
      thumbnail(video, "video/mp4", {
        size: { width: 8, height: 4 },
        output: { format: "webp", quality: 80, fit },
      }).then((output) => new Bun.Image(output).metadata());

    const [cover, contain] = await Promise.all([frame("cover"), frame("contain")]);

    expect([cover.format, cover.width, cover.height]).toEqual(["webp", 8, 4]);
    expect([contain.format, contain.width, contain.height]).toEqual(["webp", 4, 4]);
  }, 20_000);
});
