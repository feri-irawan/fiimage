import { PayloadTooLargeError, RequestTimeoutError } from "./errors";
import { assertSafeHttpUrl } from "./security";

const MAX_REDIRECTS = 5;
const MAX_FETCH_ATTEMPTS = 2;

export class RemoteBodyTooLargeError extends PayloadTooLargeError {
  constructor(message = "Remote response is too large.") {
    super(message);
    this.name = "RemoteBodyTooLargeError";
  }
}

export class RemoteTimeoutError extends RequestTimeoutError {
  constructor(message = "Remote request timed out.") {
    super(message);
    this.name = "RemoteTimeoutError";
  }
}

type FetchSafeOptions = {
  headers?: HeadersInit;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type ReadResponseBodyOptions = {
  timeoutMs?: number;
};

/** Fetch a public URL while validating every redirect target. */
export const fetchSafeResponse = async (
  startUrl: string,
  { headers, timeoutMs = 30_000, fetchImpl = fetch }: FetchSafeOptions = {}
) => {
  let currentUrl = startUrl;
  const deadline = Date.now() + timeoutMs;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new RemoteTimeoutError("Remote URL request timed out.");
    }
    await assertSafeHttpUrl(currentUrl, { timeoutMs: remainingMs });

    let response: Response | undefined;
    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
      const attemptTimeoutMs = deadline - Date.now();
      if (attemptTimeoutMs <= 0) {
        throw new RemoteTimeoutError("Remote URL request timed out.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      try {
        response = await fetchImpl(currentUrl, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new RemoteTimeoutError();
        if (attempt === MAX_FETCH_ATTEMPTS - 1 || deadline - Date.now() <= 0) {
          throw error;
        }
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (
        attempt < MAX_FETCH_ATTEMPTS - 1 &&
        [408, 425, 429, 500, 502, 503, 504].includes(response.status)
      ) {
        await response.body?.cancel();
        continue;
      }
      break;
    }

    if (!response) throw new Error("Remote URL request failed.");

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        await response.body?.cancel();
        throw new Error("Remote URL returned an invalid redirect.");
      }
      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error("Remote URL redirected too many times.");
};

const readChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineAt: number | undefined,
  timeoutMessage: string
) => {
  if (deadlineAt === undefined) return await reader.read();

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    await reader.cancel().catch(() => undefined);
    throw new RemoteTimeoutError(timeoutMessage);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject first because cancel() may immediately resolve a pending read.
          reject(new RemoteTimeoutError(timeoutMessage));
          void reader.cancel().catch(() => undefined);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Read a response body while enforcing a limit even without Content-Length. */
export const readResponseBody = async (
  response: Response,
  maxBytes: number,
  { timeoutMs }: ReadResponseBodyOptions = {}
): Promise<Buffer> => {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await readChunk(
        reader,
        deadlineAt,
        "Remote response body timed out."
      );
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteBodyTooLargeError();
      }

      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

/** Stream a bounded response body to a temporary file without buffering it. */
export const writeResponseBodyToFile = async (
  response: Response,
  filePath: string,
  maxBytes: number,
  { timeoutMs }: ReadResponseBodyOptions = {}
): Promise<number> => {
  if (!response.body) return 0;

  const reader = response.body.getReader();
  const writer = Bun.file(filePath).writer({ highWaterMark: 1024 * 1024 });
  const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let totalBytes = 0;
  let caughtError: unknown;

  try {
    while (true) {
      const { done, value } = await readChunk(
        reader,
        deadlineAt,
        "Remote response body timed out."
      );
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteBodyTooLargeError();
      }

      writer.write(value);
    }
  } catch (error) {
    caughtError = error;
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    try {
      await endWithDeadline(
        Promise.resolve(writer.end()),
        deadlineAt,
        "Temporary media file close timed out."
      );
    } catch (error) {
      if (caughtError === undefined) throw error;
    }
  }

  return totalBytes;
};

const endWithDeadline = async <T>(
  operation: Promise<T>,
  deadlineAt: number | undefined,
  timeoutMessage: string
) => {
  if (deadlineAt === undefined) return await operation;

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RemoteTimeoutError(timeoutMessage);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RemoteTimeoutError(timeoutMessage)),
          remainingMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
