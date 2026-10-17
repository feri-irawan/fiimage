import { describe, expect, test } from "bun:test";
import Chromium from "@sparticuz/chromium";
import puppeteer, { Page } from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import {
  preparePageForScreenshot,
  summarizeFailedRequests,
  waitForPageToSettle,
} from "../lib/capture";

const pixelPng = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
);

// Uses the production Chromium build; pages are served locally without the
// capture proxy because only page handling is under test.
const withPage = async (
  html: string,
  run: (page: Page, origin: string, hits: string[]) => Promise<void>
) => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      hits.push(pathname);
      if (pathname.endsWith(".png")) {
        return new Response(pixelPng, { headers: { "content-type": "image/png" } });
      }
      if (pathname === "/late") {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return new Response("loaded");
      }
      if (pathname === "/poll") return new Response("tick");
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await puppeteer.launch({
    executablePath: await Chromium.executablePath(),
    headless: "shell",
    args: await puppeteer.defaultArgs({ args: Chromium.args, headless: "shell" }),
  });
  try {
    const page = await browser.newPage();
    await run(page, `http://127.0.0.1:${server.port}`, hits);
  } finally {
    await browser.close();
    server.stop(true);
  }
};

/** Read the RGB color of one pixel of a PNG screenshot. */
const pixelAt = async (png: Uint8Array, x: number, y: number) => {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable in the test runtime.");
  const process = Bun.spawn({
    cmd: [
      ffmpegPath, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ],
    stdin: new Blob([Uint8Array.from(png)]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const pixel = await new Response(process.stdout).bytes();
  await process.exited;
  return Array.from(pixel);
};

describe("capture failure summary", () => {
  test("is empty when every request succeeded", () => {
    expect(summarizeFailedRequests(new Map(), 0)).toBeUndefined();
  });

  test("lists the most frequent failures first, with skipped requests", () => {
    const failures = new Map([
      ["img.shields.io net::ERR_TUNNEL_CONNECTION_FAILED", 2],
      ["github.githubassets.com net::ERR_TUNNEL_CONNECTION_FAILED", 12],
      ["internal.example blocked: private address", 1],
    ]);

    expect(summarizeFailedRequests(failures, 47)).toBe(
      "15 requests failed: github.githubassets.com net::ERR_TUNNEL_CONNECTION_FAILED x12, " +
        "img.shields.io net::ERR_TUNNEL_CONNECTION_FAILED x2, internal.example blocked: private address x1; " +
        "47 requests over the 300-request limit were skipped"
    );
  });

  test("keeps the line short by listing at most ten failure kinds", () => {
    const failures = new Map(
      Array.from({ length: 15 }, (_, index) => [`host${index}.example net::ERR_FAILED`, 1])
    );

    const summary = summarizeFailedRequests(failures, 0);

    expect(summary?.startsWith("15 requests failed: ")).toBe(true);
    expect(summary?.match(/ x1/g)).toHaveLength(10);
  });
});

describe("waiting for a page to settle", () => {

  test.skipIf(process.platform !== "linux")(
    "waits for content that scripts fetch after load",
    async () => {
      await withPage(
        `<script>
          addEventListener("load", () => setTimeout(() =>
            fetch("/late").then((r) => r.text()).then((text) => {
              document.body.dataset.late = text;
            }), 300));
        </script>`,
        async (page, origin) => {
          await page.goto(origin, { waitUntil: "load" });
          await waitForPageToSettle(page, Date.now() + 10_000);

          expect(await page.evaluate(() => document.body.dataset.late)).toBe("loaded");
        }
      );
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "stops waiting at the deadline when the network never goes quiet",
    async () => {
      await withPage(
        `<script>setInterval(() => fetch("/poll"), 100);</script>`,
        async (page, origin) => {
          await page.goto(origin, { waitUntil: "load" });
          const startedAt = Date.now();
          await waitForPageToSettle(page, Date.now() + 1_500);

          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
          expect(Date.now() - startedAt).toBeLessThan(3_000);
        }
      );
    },
    30_000
  );
});

describe("preparing a page for its screenshot", () => {
  const capture = async (
    page: Page,
    options: { fullPage: boolean; delay: number }
  ) => {
    const screenshotOptions = await preparePageForScreenshot(page, options, Date.now() + 20_000);
    const png = await page.screenshot(screenshotOptions);
    const { width, height } = await new Bun.Image(png).metadata();
    return { png, width, height };
  };
  const tallPage = (height: number) =>
    `<body style="margin:0"><div style="height:${height}px;background:#eee"></div>
     <img src="/lazy.png" loading="lazy" width="10" height="10"></body>`;

  test.skipIf(process.platform !== "linux")(
    "captures only the viewport by default",
    async () => {
      await withPage(tallPage(1_500), async (page, origin) => {
        await page.setViewport({ width: 400, height: 300 });
        await page.goto(origin, { waitUntil: "load" });

        const { width, height } = await capture(page, { fullPage: false, delay: 0 });

        expect([width, height]).toEqual([400, 300]);
      });
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "captures the full page and loads lazy images below the fold",
    async () => {
      // Far enough below the viewport that Chromium does not load the image
      // early on its own (it preloads lazy images within ~1250-2500px).
      await withPage(tallPage(3_800), async (page, origin, hits) => {
        await page.setViewport({ width: 400, height: 300 });
        await page.goto(origin, { waitUntil: "load" });
        await waitForPageToSettle(page, Date.now() + 5_000);
        expect(hits).not.toContain("/lazy.png");

        const screenshotOptions = await preparePageForScreenshot(
          page,
          { fullPage: true, delay: 0 },
          Date.now() + 20_000
        );
        // Requested while preparing, before the screenshot itself.
        expect(hits).toContain("/lazy.png");

        const png = await page.screenshot(screenshotOptions);
        const { width, height } = await new Bun.Image(png).metadata();
        expect(width).toBe(400);
        expect(height).toBeGreaterThanOrEqual(3_800);
      });
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "limits full-page captures to 4096 pixels high",
    async () => {
      await withPage(tallPage(6_000), async (page, origin) => {
        await page.setViewport({ width: 400, height: 300 });
        await page.goto(origin, { waitUntil: "load" });

        const { width, height } = await capture(page, { fullPage: true, delay: 0 });

        expect([width, height]).toEqual([400, 4_096]);
      });
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "waits the extra delay before capturing",
    async () => {
      const html = `<body style="margin:0;background:white">
        <script>setTimeout(() => { document.body.style.background = "red"; }, 1500);</script>`;
      for (const [delay, expected] of [[0, [255, 255, 255]], [2_000, [255, 0, 0]]] as const) {
        await withPage(html, async (page, origin) => {
          await page.setViewport({ width: 100, height: 100 });
          await page.goto(origin, { waitUntil: "load" });

          const { png } = await capture(page, { fullPage: false, delay });

          expect(await pixelAt(png, 50, 50)).toEqual([...expected]);
        });
      }
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "renders a site's dark mode when asked",
    async () => {
      const html = `<style>
          body { margin: 0; background: white; }
          @media (prefers-color-scheme: dark) { body { background: black; } }
        </style><body>`;
      await withPage(html, async (page, origin) => {
        await page.setViewport({ width: 100, height: 100 });
        // The same call capture() makes for `dark=1`.
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        await page.goto(origin, { waitUntil: "load" });

        const { png } = await capture(page, { fullPage: false, delay: 0 });

        expect(await pixelAt(png, 50, 50)).toEqual([0, 0, 0]);
      });
    },
    30_000
  );
});
