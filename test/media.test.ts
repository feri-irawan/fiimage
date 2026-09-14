import { describe, expect, test } from "bun:test";
import { generateThumbnail } from "../lib/ffmpeg";

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
);

const mockMediaFetch = (contentType: string) =>
  (async () =>
    new Response(png, {
      headers: {
        "content-length": String(png.byteLength),
        "content-type": contentType,
      },
    })) as unknown as typeof fetch;

describe("thumbnail generation", () => {
  test("uses Bun.Image for raster image responses", async () => {
    mockMediaFetch("image/png");

    const output = await generateThumbnail(
      "https://8.8.8.8/image.png",
      { width: 2, height: -1 },
      undefined,
      mockMediaFetch("image/png")
    );
    const metadata = await new Bun.Image(output).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
  });

  test("uses the non-shell FFmpeg path for other media", async () => {
    mockMediaFetch("application/octet-stream");

    const output = await generateThumbnail(
      "https://8.8.8.8/media",
      { width: -1, height: 2 },
      undefined,
      mockMediaFetch("application/octet-stream")
    );

    expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 10_000);
});
