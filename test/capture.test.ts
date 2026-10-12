import { describe, expect, test } from "bun:test";
import Chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { summarizeFailedRequests, waitForPageToSettle } from "../lib/capture";

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
  // Uses the production Chromium build; pages are served locally without the
  // capture proxy because only the waiting logic is under test.
  const withPage = async (
    html: string,
    run: (page: import("puppeteer-core").Page, origin: string) => Promise<void>
  ) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
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
      await run(page, `http://127.0.0.1:${server.port}`);
    } finally {
      await browser.close();
      server.stop(true);
    }
  };

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
