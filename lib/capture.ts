/**
 * Capture the Web Page
 */

import Chromium from "@sparticuz/chromium";
import { Request, Response } from "express";
import puppeteer from "puppeteer-core";
import { z } from "zod";
import { assertSafeHttpUrl, UnsafeHttpUrlError } from "./security";
import { MAX_RESPONSE_BYTES, sendGeneratedImage } from "./response";
import { captureSizeSchema, httpUrlSchema } from "./validation";
import { PayloadTooLargeError, RequestTimeoutError } from "./errors";
import { generationGate } from "./concurrency";

const querySchema = z.object({ url: httpUrlSchema, s: captureSizeSchema });
const MAX_PAGE_REQUESTS = 100;
const MAX_PAGE_BYTES = 50 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = MAX_RESPONSE_BYTES;
const RESOURCE_READY_TIMEOUT = 3_000;
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
 * Route handler for `/capture`
 */
export const capture = async (req: Request, res: Response) => {
  try {
    // Get the query string
    const { url, s } = querySchema.parse(req.query);
    const release = generationGate.tryAcquire();
    if (!release) {
      res.status(429).json({ error: "Too many image generations are in progress." });
      return;
    }

    try {
      await assertSafeHttpUrl(url);

      // Generate the image
      const image = await captureTheWeb({ url, s });

      // Send the response
      sendGeneratedImage(res, "image/png", image);
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
const captureTheWeb = async ({ url, s }: z.infer<typeof querySchema>) => {
  const deadlineAt = Date.now() + CAPTURE_TIMEOUT_MS;
  const executablePath = await withTimeout(
    Chromium.executablePath(),
    Math.max(1, deadlineAt - Date.now()),
    "Chromium preparation timed out."
  );
  const args = await withTimeout(
    puppeteer.defaultArgs({ args: Chromium.args, headless: "shell" }),
    remainingTime(deadlineAt),
    "Browser argument preparation timed out."
  );
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
    page.on("request", (request) => {
      requestCount += 1;
      if (requestCount > MAX_PAGE_REQUESTS) {
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

      void assertSafeHttpUrl(requestUrl)
        .then(() => {
          if (!request.isInterceptResolutionHandled()) return request.continue();
        })
        .catch(() => {
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
      throw error;
    }
    if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");

    await withTimeout(
      Promise.race([
        // Keep this callback synchronous. TypeScript downlevels async
        // callbacks for the server bundle, but Puppeteer serializes the
        // callback and runs it in the page where the generated __awaiter
        // helper does not exist.
        page.evaluate(() => {
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
        }),
        new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(RESOURCE_READY_TIMEOUT, Math.max(1, deadlineAt - Date.now()))
          )
        ),
        pageBudget,
      ]),
      Math.max(1, deadlineAt - Date.now()),
      "Page readiness timed out."
    );
    if (pageBytesExceeded) throw new PayloadTooLargeError("Remote page is too large.");

    const screenshot = await withTimeout(
      page.screenshot({ type: "png" }),
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
    try {
      await withTimeout(browser.close(), 2_000, "Browser close timed out.");
    } catch {
      browser.process()?.kill("SIGKILL");
    }
  }
};
