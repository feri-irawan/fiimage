import ffmpegPath from "ffmpeg-static";
import {
  fetchSafeResponse,
  readResponseBody,
  RemoteBodyTooLargeError,
  writeResponseBodyToFile,
} from "./remote";
import { MAX_DIMENSION } from "./validation";
import { MAX_RESPONSE_BYTES } from "./response";
import { PayloadTooLargeError, UpstreamResponseError } from "./errors";

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 50_000;
const MAX_OUTPUT_BYTES = MAX_RESPONSE_BYTES;
const MAX_STDERR_BYTES = 64 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export type ThumbnailSize = {
  width: number;
  height: number;
};

const getScaleFilter = (size: ThumbnailSize) => {
  if (size.width === -1) {
    return `min(${MAX_DIMENSION}\\,iw*${size.height}/ih):${size.height}`;
  }
  if (size.height === -1) {
    return `${size.width}:min(${MAX_DIMENSION}\\,ih*${size.width}/iw)`;
  }
  return `${size.width}:${size.height}`;
};

/** Generate one JPEG frame from a response without passing user input to a shell. */
export const generateVideoThumbnail = async (
  response: Response,
  size: ThumbnailSize,
  seek?: number,
  deadlineAt = Date.now() + FFMPEG_TIMEOUT_MS
): Promise<Buffer> => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this platform.");
  if (!response.body) throw new Error("Remote media response has no body.");

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_INPUT_BYTES) {
    await response.body.cancel();
    throw new PayloadTooLargeError("Remote media is too large.");
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-protocol_whitelist",
    "pipe",
    "-i",
    "pipe:0",
    ...(seek === undefined ? [] : ["-ss", String(seek)]),
    "-frames:v",
    "1",
    "-vf",
    `scale=${getScaleFilter(size)}`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];

  const inputPath = `/tmp/fiimage-${crypto.randomUUID()}.media`;
  try {
    await writeResponseBodyToFile(
      response,
      inputPath,
      MAX_INPUT_BYTES,
      { timeoutMs: Math.max(1, deadlineAt - Date.now()) }
    );
    const processTimeout = Math.max(1, deadlineAt - Date.now());
    const process = Bun.spawn({
      cmd: [ffmpegPath, ...args],
      stdin: Bun.file(inputPath),
      stdout: "pipe",
      stderr: "pipe",
      timeout: processTimeout,
      killSignal: "SIGKILL",
    });

    let output: Buffer;
    let stderr: string;
    let exitCode: number;
    try {
      [output, stderr, exitCode] = await Promise.all([
        readResponseBody(new Response(process.stdout), MAX_OUTPUT_BYTES, {
          timeoutMs: processTimeout,
        }),
        readResponseBody(new Response(process.stderr), MAX_STDERR_BYTES, {
          timeoutMs: processTimeout,
        })
          .catch((error) => {
            if (error instanceof RemoteBodyTooLargeError) {
              return Buffer.from("[stderr truncated]");
            }
            throw error;
          })
          .then((body) => new TextDecoder().decode(body)),
        process.exited,
      ]);
    } catch (error) {
      process.kill("SIGKILL");
      await process.exited;
      throw error;
    }

    if (exitCode !== 0) {
      throw new Error(
        `FFmpeg exited with code ${exitCode}.${stderr ? ` ${stderr.trim()}` : ""}`
      );
    }

    if (output.length === 0) throw new Error("FFmpeg returned no image.");
    return output;
  } finally {
    await Bun.file(inputPath).delete().catch(() => undefined);
  }
};

/** Fetch media and dispatch raster images or video to the appropriate pipeline. */
export const generateThumbnail = async (
  url: string,
  size: ThumbnailSize,
  seek?: number,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> => {
  const deadlineAt = Date.now() + FFMPEG_TIMEOUT_MS;
  const response = await fetchSafeResponse(url, {
    headers: { Accept: "image/*,video/*,*/*;q=0.8" },
    timeoutMs: FFMPEG_TIMEOUT_MS,
    fetchImpl,
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamResponseError(
      response.status,
      `Unable to fetch media (HTTP ${response.status}).`
    );
  }

  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(contentType)) {
    const { generateImageThumbnail } = await import("./image");
    return await generateImageThumbnail(response, size, deadlineAt);
  }

  return await generateVideoThumbnail(response, size, seek, deadlineAt);
};
