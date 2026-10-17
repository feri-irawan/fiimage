/**
 * Capture the Web Page
 */

import Chromium from "@sparticuz/chromium";
import { Request, Response } from "express";
import puppeteer, { Page, TimeoutError } from "puppeteer-core";
import { z } from "zod";
import { assertSafeHttpUrl, UnsafeHttpUrlError } from "./security";
import {
  MAX_RESPONSE_BYTES,
  sendGeneratedImage,
  sendTooManyRequests,
} from "./response";
import {
  captureDelaySchema,
  captureSizeSchema,
  darkSchema,
  fullPageSchema,
  httpUrlSchema,
  MAX_DIMENSION,
  OUTPUT_CONTENT_TYPES,
  OutputFormat,
  outputFormatSchema,
  qualitySchema,
} from "./validation";
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  UpstreamRequestError,
} from "./errors";
import { generationGate } from "./concurrency";
import { getBrowserProxyArgs, startBrowserProxy } from "./browser-proxy";

const querySchema = z.object({
  url: httpUrlSchema,
  s: captureSizeSchema,
  fullPage: fullPageSchema,
  delay: captureDelaySchema,
  dark: darkSchema,
  // JPEG by default: about half the size of PNG for a typical page.
  f: outputFormatSchema,
  q: qualitySchema,
});
// Content-heavy pages (GitHub, news sites) make well over 100 requests; a low
// cap drops their later images and icons. The byte budget and deadlines below
// still bound the total work.
const MAX_PAGE_REQUESTS = 300;
const MAX_PAGE_BYTES = 50 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = MAX_RESPONSE_BYTES;
// After `load`, pages keep fetching content (GitHub's file list, lazy
// widgets). Wait until the network is quiet, but never longer than this.
const SETTLE_TIMEOUT_MS = 6_000;
const NETWORK_IDLE_MS = 500;
const CAPTURE_TIMEOUT_MS = 50_000;

const remainingTime = (deadlineAt: number) =>
  Math.max(1, deadlineAt - Date.now());

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Summarize failed subresources as one log line, so a capture that renders
 * without styles or images shows which hosts failed and why.
 */
export const summarizeFailedRequests = (
  failures: Map<string, number>,
  skippedRequests: number
) => {
  const parts: string[] = [];
  if (failures.size > 0) {
    const total = [...failures.values()].reduce((sum, count) => sum + count, 0);
    const top = [...failures]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([reason, count]) => `${reason} x${count}`);
    parts.push(`${total} requests failed: ${top.join(", ")}`);
  }
  if (skippedRequests > 0) {
    parts.push(
      `${skippedRequests} requests over the ${MAX_PAGE_REQUESTS}-request limit were skipped`
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
};

/**
 * Wait for content that arrives after `load`: requests started by scripts
 * (until the network has been idle for NETWORK_IDLE_MS), images, and web
 * fonts. Bounded, so pages that never go quiet are still captured.
 */
export const waitForPageToSettle = async (page: Page, deadlineAt: number) => {
  const limitMs = Math.min(SETTLE_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([
        page
          .waitForNetworkIdle({ idleTime: NETWORK_IDLE_MS, timeout: limitMs })
          .catch(() => undefined),
        // Keep this callback synchronous. TypeScript downlevels async
        // callbacks for the server bundle, but Puppeteer serializes the
        // callback and runs it in the page where the generated __awaiter
        // helper does not exist.
        page
          .evaluate(() => {
            const imagesReady = Promise.all(
              Array.from(document.images, (image) => {
                if (image.complete) return Promise.resolve();
                return new Promise<void>((resolve) => {
                  image.addEventListener("load", () => resolve(), { once: true });
                  image.addEventListener("error", () => resolve(), { once: true });
                });
              })
            );

            return imagesReady.then(() => document.fonts?.ready);
          })
          .catch(() => undefined),
      ]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Full-page captures scroll through the page first so lazy-loaded images and
// sections start loading, a viewport at a time, for at most this long.
const SCROLL_BUDGET_MS = 4_000;
const SCROLL_STEP_DELAY_MS = 100;

/** Scroll down to the capture height a viewport at a time, then back up. */
const scrollThroughPage = async (page: Page, deadlineAt: number) => {
  const budgetMs = Math.min(SCROLL_BUDGET_MS, Math.max(0, deadlineAt - Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // Keep this callback synchronous; see waitForPageToSettle.
      page
        .evaluate(
          (maxHeight, stepDelayMs, scrollBudgetMs) =>
            new Promise<void>((resolve) => {
              const startedAt = Date.now();
              const step = () => {
                const end = Math.min(document.documentElement.scrollHeight, maxHeight);
                const next = window.scrollY + window.innerHeight;
                if (next >= end || Date.now() - startedAt > scrollBudgetMs) {
                  window.scrollTo(0, 0);
                  resolve();
                  return;
                }
                window.scrollTo(0, next);
                setTimeout(step, stepDelayMs);
              };
              step();
            }),
          MAX_DIMENSION,
          SCROLL_STEP_DELAY_MS,
          budgetMs
        )
        .catch(() => undefined),
      // A page that blocks its timers must not hold up the capture.
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs + 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type ScreenshotOptions = {
  /** Capture the whole page height (up to MAX_DIMENSION), not the viewport. */
  fullPage: boolean;
  /** Extra milliseconds to wait after the page settles. */
  delay: number;
  /** Image format; PNG when not given. The route always passes one. */
  format?: OutputFormat;
  /** JPEG and WebP quality from 1 to 100. */
  quality?: number;
};

/**
 * Get a loaded page ready and return its screenshot settings: scroll through
 * full pages so lazy content loads, wait for the page to settle, then wait
 * any extra delay the caller asked for.
 */
export const preparePageForScreenshot = async (
  page: Page,
  { fullPage, delay, format = "png", quality = 85 }: ScreenshotOptions,
  deadlineAt: number
) => {
  if (fullPage) await scrollThroughPage(page, deadlineAt);
  await waitForPageToSettle(page, deadlineAt);
  if (delay > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delay, Math.max(0, deadlineAt - Date.now())))
    );
  }
  // Puppeteer rejects a quality for PNG, which is lossless.
  const encoding = format === "png" ? { type: format } : { type: format, quality };
  if (!fullPage) return encoding;

  const height = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  );
  return {
    ...encoding,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: page.viewport()?.width ?? 0,
      height: Math.min(Math.max(1, height), MAX_DIMENSION),
    },
  };
};

/** Map Puppeteer navigation failures to client-facing errors. */
export const toNavigationError = (error: unknown) => {
  if (error instanceof TimeoutError) {
    return new RequestTimeoutError("Page navigation timed out.");
  }
  // Chromium reports DNS, connection, TLS and blocked-request failures as
  // `net::ERR_*`, e.g. "net::ERR_CONNECTION_REFUSED at https://...".
  if (error instanceof Error && error.message.startsWith("net::ERR_")) {
    return new UpstreamRequestError("Unable to load the remote page.", {
      cause: error,
    });
  }
  return error;
};

/**
 * Route handler for `/capture`
 */
export const capture = async (req: Request, res: Response) => {
  try {
    // Get the query string
    const query = querySchema.parse(req.query);
    const release = generationGate.tryAcquire();
    if (!release) {
      sendTooManyRequests(res);
      return;
    }

    try {
      await assertSafeHttpUrl(query.url);

      // Generate the image
      const image = await captureTheWeb(query);

      // Send the response
      sendGeneratedImage(res, OUTPUT_CONTENT_TYPES[query.f], image);
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(z.prettifyError(error));
      res.status(400).json(z.flattenError(error));
      return;
    }
    if (error instanceof UnsafeHttpUrlError) {
      res.status(400).json({ error: error.message });
      return;
    }

    throw error;
  }
};

/** Capture the web page using Puppeteer */
const captureTheWeb = async (query: z.infer<typeof querySchema>) => {
  // Every browser request goes through this proxy, which connects only to
  // the address it validated so DNS rebinding cannot reach private networks.
  const proxy = await startBrowserProxy();
  try {
    return await captureThroughProxy(query, proxy.url);
  } finally {
    proxy.close();
  }
};

const captureThroughProxy = async (
  { url, s, fullPage, delay, dark, f, q }: z.infer<typeof querySchema>,
  proxyUrl: string
) => {
  const deadlineAt = Date.now() + CAPTURE_TIMEOUT_MS;
  const executablePath = await withTimeout(
    Chromium.executablePath(),
    Math.max(1, deadlineAt - Date.now()),
    "Chromium preparation timed out."
  );
  const args = [
    ...(await withTimeout(
      puppeteer.defaultArgs({ args: Chromium.args, headless: "shell" }),
      remainingTime(deadlineAt),
      "Browser argument preparation timed out."
    )),
    ...getBrowserProxyArgs(proxyUrl),
  ];
  const launchPromise = puppeteer.launch({
    args,
    executablePath,
    headless: "shell",
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try {
    browser = await withTimeout(
      launchPromise,
      Math.max(1, deadlineAt - Date.now()),
      "Browser launch timed out."
    );
  } catch (error) {
    // A race timeout cannot cancel Puppeteer's launch promise. If the browser
    // arrives after the request expires, close it immediately and kill it when
    // close is unavailable so it cannot outlive the invocation.
    void launchPromise
      .then(async (lateBrowser) => {
        try {
          await withTimeout(
            lateBrowser.close(),
            2_000,
            "Late browser close timed out."
          );
        } catch {
          lateBrowser.process()?.kill("SIGKILL");
        }
      })
      .catch(() => undefined);
    throw error;
  }

  const failures = new Map<string, number>();
  let skippedRequests = 0;
  try {
    const page = await withTimeout(
      browser.newPage(),
      remainingTime(deadlineAt),
      "Page creation timed out."
    );
    let requestCount = 0;
    let pageBytes = 0;
    let pageBytesExceeded = false;
    let rejectPageBudget!: (error: Error) => void;
    const pageBudget = new Promise<never>((_, reject) => {
      rejectPageBudget = reject;
    });
    // The budget can trip during navigation, before the readiness race below
    // starts listening. Mark the promise handled without swallowing it there.
    void pageBudget.catch(() => undefined);
    const client = await withTimeout(
      page.createCDPSession(),
      remainingTime(deadlineAt),
      "Browser protocol setup timed out."
    );
    await withTimeout(
      client.send("Network.enable"),
      remainingTime(deadlineAt),
      "Browser network setup timed out."
    );
    await withTimeout(
      page.setBypassServiceWorker(true),
      remainingTime(deadlineAt),
      "Browser service-worker setup timed out."
    );
    await withTimeout(
      client.send("Network.setBlockedURLs", {
        urls: ["file:*", "ftp:*", "ws:*", "wss:*", "javascript:*"]
      }),
      remainingTime(deadlineAt),
      "Browser protocol filtering timed out."
    );
    page.on("popup", (popup) => {
      if (!popup) return;
      void popup.close().catch(() => undefined);
    });
    client.on("Network.dataReceived", ({ encodedDataLength }) => {
      pageBytes += encodedDataLength;
      if (pageBytes <= MAX_PAGE_BYTES || pageBytesExceeded) return;

      pageBytesExceeded = true;
      rejectPageBudget(new PayloadTooLargeError("Remote page is too large."));
      void client.send("Page.stopLoading").catch(() => undefined);
    });

    await withTimeout(
      page.setRequestInterception(true),
      remainingTime(deadlineAt),
      "Browser request setup timed out."
    );
    // Requests this handler aborts on purpose; their failures are reported
    // as skipped or blocked rather than as network errors.
    const skipped = new WeakSet<object>();
    const blocked = new WeakMap<object, string>();
    page.on("requestfailed", (request) => {
      if (skipped.has(request)) return;
      let host = "(invalid URL)";
      try {
        host = new URL(request.url()).host || request.url().slice(0, 40);
      } catch {}
      const reason =
        blocked.get(request) ?? request.failure()?.errorText ?? "failed";
      const key = `${host} ${reason}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    });
    page.on("request", (request) => {
      requestCount += 1;
      if (requestCount > MAX_PAGE_REQUESTS) {
        skippedRequests += 1;
        skipped.add(request);
        void request.abort().catch(() => undefined);
        return;
      }

      const requestUrl = request.url();
      const protocol = (() => {
        try {
          return new URL(requestUrl).protocol;
        } catch {
          return "";
        }
      })();

      if (["about:", "blob:", "data:"].includes(protocol)) {
        void request.continue().catch(() => undefined);
        return;
      }

      // A fast first filter; the proxy repeats the check on the address it
      // actually connects to, which is what stops DNS rebinding.
      void assertSafeHttpUrl(requestUrl)
        .then(() => {
          if (!request.isInterceptResolutionHandled()) return request.continue();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "";
          blocked.set(
            request,
            message.startsWith("Unable to resolve")
              ? "DNS lookup failed"
              : message.startsWith("Private network")
                ? "blocked: private address"
                : "blocked: unsupported URL"
          );
          if (!request.isInterceptResolutionHandled()) return request.abort();
        })
        .catch(() => undefined);
    });

    await withTimeout(
      page.setViewport({
        width: s.width,
        height: s.height,
        deviceScaleFactor: 1,
      }),
      remainingTime(deadlineAt),
      "Browser viewport setup timed out."
    );
    if (dark) {
      // Before navigation, so pages that read the scheme on load see it.
      await withTimeout(
        page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]),
        remainingTime(deadlineAt),
        "Browser color scheme setup timed out."
      );
    }
    try {
      await withTimeout(
        page.goto(url, {
          timeout: Math.min(15_000, Math.max(1, deadlineAt - Date.now())),
          waitUntil: "load",
        }),
        Math.max(1, deadlineAt - Date.now()),
        "Page capture timed out."
      );
    } catch (error) {
      if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");
      throw toNavigationError(error);
    }
    if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");

    const screenshotOptions = await withTimeout(
      Promise.race([
        preparePageForScreenshot(
          page,
          { fullPage, delay, format: f, quality: q },
          deadlineAt
        ),
        pageBudget,
      ]),
      Math.max(1, deadlineAt - Date.now()),
      "Page readiness timed out."
    );
    if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");

    const screenshot = await withTimeout(
      page.screenshot(screenshotOptions),
      Math.max(1, deadlineAt - Date.now()),
      "Screenshot timed out."
    );
    const image = Buffer.from(screenshot);
    if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");
    if (image.length > MAX_SCREENSHOT_BYTES) {
      throw new PayloadTooLargeError("Generated screenshot is too large.");
    }
    return image;
  } finally {
    // Vercel keeps these lines in the function logs.
    const summary = summarizeFailedRequests(failures, skippedRequests);
    if (summary) console.warn(`[capture] ${new URL(url).host}: ${summary}`);
    try {
      await withTimeout(browser.close(), 2_000, "Browser close timed out.");
    } catch {
      browser.process()?.kill("SIGKILL");
    }
  }
};
