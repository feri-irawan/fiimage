import ffmpegPath from "ffmpeg-static";
import {
  fetchSafeResponse,
  readResponseBody,
  RemoteBodyTooLargeError,
  writeResponseBodyToFile,
} from "./remote";
import { Fit, MAX_DIMENSION } from "./validation";
import {
  DEFAULT_OUTPUT,
  encodeFrame,
  hasFixedBox,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_PIXELS,
  OutputOptions,
  ThumbnailSize,
} from "./image";
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  UnprocessableMediaError,
  UnsupportedMediaTypeError,
  UpstreamResponseError,
} from "./errors";

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 50_000;
// FFmpeg hands over one lossless PNG frame, which is re-encoded in the
// requested format; a full-size frame can be far larger than the response.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

/**
 * Content types that are clearly documents, such as a web page passed as
 * `url`. Other types, including `text/plain` and `application/octet-stream`,
 * are still handed to FFmpeg because some hosts mislabel media.
 */
const isDocumentType = (contentType: string) =>
  (contentType.startsWith("text/") && contentType !== "text/plain") ||
  contentType === "application/json" ||
  contentType === "application/xml" ||
  contentType === "application/javascript" ||
  contentType.endsWith("+json") ||
  contentType.endsWith("+xml");

export type ThumbnailOptions = {
  size: ThumbnailSize;
  /** Video timestamp in seconds. */
  seek?: number;
  output?: OutputOptions;
};

const getVideoFilter = (size: ThumbnailSize, fit: Fit) => {
  if (size.width === -1) {
    return `scale=min(${MAX_DIMENSION}\\,iw*${size.height}/ih):${size.height}`;
  }
  if (size.height === -1) {
    return `scale=${size.width}:min(${MAX_DIMENSION}\\,ih*${size.width}/iw)`;
  }
  const box = `${size.width}:${size.height}`;
  if (fit === "contain") return `scale=${box}:force_original_aspect_ratio=decrease`;
  if (fit === "cover") {
    return `scale=${box}:force_original_aspect_ratio=increase,crop=${box}`;
  }
  return `scale=${box}`;
};

/**
 * Generate one frame with FFmpeg without passing user input to a shell: a
 * video frame, or a still image that needs the `cover` crop.
 */
export const generateFrameThumbnail = async (
  response: Response,
  { size, seek, output = DEFAULT_OUTPUT }: ThumbnailOptions,
  deadlineAt = Date.now() + FFMPEG_TIMEOUT_MS,
  maxInputBytes = MAX_INPUT_BYTES
): Promise<Buffer> => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this platform.");
  if (!response.body) throw new Error("Remote media response has no body.");

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxInputBytes) {
    await response.body.cancel();
    throw new PayloadTooLargeError("Remote media is too large.");
  }

  // The non-standard extension also keeps FFmpeg from auto-detecting HLS
  // playlists, which could otherwise reference other local files.
  const inputPath = `/tmp/fiimage-${crypto.randomUUID()}.media`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    // Refuse frames larger than the image pipeline accepts before decoding
    // them, so a small file cannot claim a huge canvas.
    "-max_pixels",
    String(MAX_SOURCE_PIXELS),
    // Seek as an input option so FFmpeg jumps to the nearest keyframe instead
    // of decoding every frame before `t`.
    ...(seek === undefined ? [] : ["-ss", String(seek)]),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    getVideoFilter(size, output.fit),
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ];

  try {
    await writeResponseBodyToFile(
      response,
      inputPath,
      maxInputBytes,
      { timeoutMs: Math.max(1, deadlineAt - Date.now()) }
    );
    const processTimeout = Math.max(1, deadlineAt - Date.now());
    const process = Bun.spawn({
      cmd: [ffmpegPath, ...args],
      stdout: "pipe",
      stderr: "pipe",
      timeout: processTimeout,
      killSignal: "SIGKILL",
    });

    let frame: Buffer;
    let stderr: string;
    let exitCode: number;
    try {
      [frame, stderr, exitCode] = await Promise.all([
        readResponseBody(new Response(process.stdout), MAX_FRAME_BYTES, {
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

    if (process.signalCode) {
      if (Date.now() >= deadlineAt) {
        throw new RequestTimeoutError("Media processing timed out.");
      }
      throw new Error(`FFmpeg was killed by ${process.signalCode}.`);
    }
    if (exitCode !== 0 && stderr.includes("exceeds specified max pixel count")) {
      throw new PayloadTooLargeError("Remote media dimensions are too large.");
    }
    if (exitCode !== 0) {
      throw new UnprocessableMediaError("Unable to decode the remote media.", {
        cause: new Error(
          `FFmpeg exited with code ${exitCode}.${stderr ? ` ${stderr.trim()}` : ""}`
        ),
      });
    }

    // FFmpeg exits successfully without a frame when seeking past the end.
    if (frame.length === 0) {
      throw new UnprocessableMediaError(
        seek ? "`t` is beyond the end of the media." : "Remote media has no video frames."
      );
    }
    return await encodeFrame(frame, output, deadlineAt);
  } finally {
    await Bun.file(inputPath).delete().catch(() => undefined);
  }
};

/** Fetch media and dispatch raster images or video to the appropriate pipeline. */
export const generateThumbnail = async (
  url: string,
  { size, seek, output = DEFAULT_OUTPUT }: ThumbnailOptions,
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
    // A still image has no timestamp, so `t` does not apply.
    if (output.fit === "cover" && hasFixedBox(size)) {
      return await generateFrameThumbnail(
        response,
        { size, output },
        deadlineAt,
        MAX_IMAGE_BYTES
      );
    }
    const { generateImageThumbnail } = await import("./image");
    return await generateImageThumbnail(response, size, output, deadlineAt);
  }
  if (isDocumentType(contentType)) {
    await response.body?.cancel();
    throw new UnsupportedMediaTypeError(
      `The remote URL is not an image or video (${contentType}).`
    );
  }

  return await generateFrameThumbnail(response, { size, seek, output }, deadlineAt);
};
