import {
  PayloadTooLargeError,
  RequestTimeoutError,
  UpstreamRequestError,
} from "./errors";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { HostLookup, resolveSafeHttpUrl } from "./security";

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
  lookupImpl?: HostLookup;
};

/**
 * Build a request that connects to an already validated address. Resolving
 * the hostname again in fetch would let a DNS rebinding answer swap in a
 * private address after the safety check. The original hostname is kept for
 * the Host header, TLS SNI, and certificate verification.
 */
export const createPinnedRequest = (
  rawUrl: string,
  address: string,
  headers: HeadersInit | undefined
): [string, Parameters<typeof fetch>[1]] => {
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return [rawUrl, { headers }];

  const target = new URL(url);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const pinnedHeaders = new Headers(headers);
  pinnedHeaders.set("Host", url.host);

  return [
    target.toString(),
    {
      headers: pinnedHeaders,
      ...(url.protocol === "https:"
        ? {
            tls: {
              serverName: hostname,
              checkServerIdentity: (_host, certificate) =>
                checkServerIdentity(hostname, certificate),
            },
          }
        : {}),
    },
  ];
};

type ReadResponseBodyOptions = {
  timeoutMs?: number;
};

/**
 * Identifies fiimage to the sites it fetches from. Some, such as Wikimedia,
 * ask automated clients for this and may block generic library agents.
 */
export const USER_AGENT = "fiimage (+https://github.com/feri-irawan/fiimage)";

/** Fetch a public URL while validating every redirect target. */
export const fetchSafeResponse = async (
  startUrl: string,
  { headers, timeoutMs = 30_000, fetchImpl = fetch, lookupImpl }: FetchSafeOptions = {}
) => {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("user-agent")) requestHeaders.set("User-Agent", USER_AGENT);
  let currentUrl = startUrl;
  const deadline = Date.now() + timeoutMs;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new RemoteTimeoutError("Remote URL request timed out.");
    }
    const { addresses } = await resolveSafeHttpUrl(currentUrl, {
      timeoutMs: remainingMs,
      lookupImpl,
    });

    let response: Response | undefined;
    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
      const attemptTimeoutMs = deadline - Date.now();
      if (attemptTimeoutMs <= 0) {
        throw new RemoteTimeoutError("Remote URL request timed out.");
      }

      // A retry moves on to the next validated address, if there is one.
      const [input, init] = createPinnedRequest(
        currentUrl,
        addresses[attempt % addresses.length],
        requestHeaders
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      try {
        response = await fetchImpl(input, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new RemoteTimeoutError();
        if (attempt === MAX_FETCH_ATTEMPTS - 1 || deadline - Date.now() <= 0) {
          throw new UpstreamRequestError("Unable to reach the remote URL.", {
            cause: error,
          });
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

    if (!response) throw new UpstreamRequestError("Remote URL request failed.");

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      try {
        if (!location) throw new Error("Missing Location header.");
        currentUrl = new URL(location, currentUrl).toString();
      } catch (error) {
        throw new UpstreamRequestError("Remote URL returned an invalid redirect.", {
          cause: error,
        });
      }
      continue;
    }

    // Report the hostname URL, not the pinned IP, so callers resolve relative
    // links (such as Open Graph icons) against the page's real origin.
    Object.defineProperty(response, "url", { value: currentUrl });
    return response;
  }

  throw new UpstreamRequestError("Remote URL redirected too many times.");
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
