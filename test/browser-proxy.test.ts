import { describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import Chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { getBrowserProxyArgs, startBrowserProxy } from "../lib/browser-proxy";
import { resolveSafeHttpUrl } from "../lib/security";

const proxyPort = (proxyUrl: string) => Number(new URL(proxyUrl).port);

/** Send an absolute-form request through the proxy, as Chromium does for HTTP. */
const requestViaProxy = (
  proxyUrl: string,
  url: string,
  headers: Record<string, string> = {}
) =>
  new Promise<{ status: number; rawHeaders: string[]; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort(proxyUrl),
        path: url,
        headers: { Host: new URL(url).host, ...headers },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, rawHeaders: response.rawHeaders, body })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });

/** Open a CONNECT tunnel and send one raw HTTP request through it. */
const tunnelViaProxy = (proxyUrl: string, authority: string, path = "/") =>
  new Promise<{ status: string; body: string }>((resolve, reject) => {
    const socket = net.connect(proxyPort(proxyUrl), "127.0.0.1", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    );
    let buffer = "";
    let status = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (status || !buffer.includes("\r\n\r\n")) return;
      status = buffer.split("\r\n")[0];
      buffer = "";
      if (!status.includes(" 200 ")) return;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("end", () => resolve({ status, body: buffer.split("\r\n\r\n")[1] ?? "" }));
    socket.on("error", reject);
  });

/** A local origin that records every request it receives. */
const startOrigin = (respond?: (request: Request) => Response) => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      hits.push(new URL(request.url).pathname);
      return respond?.(request) ?? new Response(`host=${request.headers.get("host")}`);
    },
  });
  return { server, hits };
};

/** Treat `<name>.public.test` as public and send it to the local origin. */
const resolveTestHosts = async (url: string) => {
  if (new URL(url).hostname.endsWith(".public.test")) return "127.0.0.1";
  throw new Error("Rejected by the test resolver.");
};

describe("browser proxy", () => {
  test("forwards plain HTTP to the validated address with the original Host", async () => {
    let received: Headers | undefined;
    const origin = startOrigin((request) => {
      received = request.headers;
      // A distinctive value; the proxy adds its own Keep-Alive for its client.
      const headers = new Headers({ "Keep-Alive": "timeout=99" });
      headers.append("Set-Cookie", "a=1");
      headers.append("Set-Cookie", "b=2");
      return new Response("hello", { headers });
    });
    const proxy = await startBrowserProxy({ resolveAddress: resolveTestHosts });
    try {
      const response = await requestViaProxy(
        proxy.url,
        `http://site.public.test:${origin.server.port}/page?x=1`,
        { "Proxy-Connection": "keep-alive", "Proxy-Authorization": "Basic secret" }
      );
      const responseHeaders = response.rawHeaders.map((value) => value.toLowerCase());

      expect(response.status).toBe(200);
      expect(response.body).toBe("hello");
      expect(origin.hits).toEqual(["/page"]);
      expect(received?.get("host")).toBe(`site.public.test:${origin.server.port}`);
      expect(received?.has("proxy-connection")).toBe(false);
      expect(received?.has("proxy-authorization")).toBe(false);
      expect(responseHeaders.filter((value) => value === "set-cookie")).toHaveLength(2);
      expect(responseHeaders).not.toContain("timeout=99");
    } finally {
      proxy.close();
      origin.server.stop(true);
    }
  });

  test("drops plain HTTP requests to rejected hosts without contacting them", async () => {
    const origin = startOrigin();
    const proxy = await startBrowserProxy({ resolveAddress: resolveTestHosts });
    try {
      await expect(
        requestViaProxy(proxy.url, `http://internal.test:${origin.server.port}/secret`)
      ).rejects.toThrow();
      expect(origin.hits).toEqual([]);
    } finally {
      proxy.close();
      origin.server.stop(true);
    }
  });

  test("tunnels CONNECT requests to the validated address", async () => {
    const origin = startOrigin();
    const proxy = await startBrowserProxy({ resolveAddress: resolveTestHosts });
    try {
      const authority = `site.public.test:${origin.server.port}`;
      const result = await tunnelViaProxy(proxy.url, authority, "/tunnel");

      expect(result.status).toBe("HTTP/1.1 200 Connection Established");
      expect(result.body).toBe(`host=${authority}`);
      expect(origin.hits).toEqual(["/tunnel"]);
    } finally {
      proxy.close();
      origin.server.stop(true);
    }
  });

  test.each([
    ["a hostname resolving to loopback", "rebind.example:443"],
    ["a literal loopback address", "127.0.0.1:443"],
    ["a literal metadata address", "169.254.169.254:80"],
  ])("refuses CONNECT to %s with the default resolver", async (_, authority) => {
    const proxy = await startBrowserProxy({
      lookupImpl: async () => [{ address: "127.0.0.1" }],
    });
    try {
      const result = await tunnelViaProxy(proxy.url, authority);

      expect(result.status).toBe("HTTP/1.1 403 Forbidden");
    } finally {
      proxy.close();
    }
  });

  test("keeps serving after a browser resets a tunnel during DNS resolution", async () => {
    const origin = startOrigin();
    const proxy = await startBrowserProxy({
      resolveAddress: async (url) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return resolveTestHosts(url);
      },
    });
    try {
      const authority = `site.public.test:${origin.server.port}`;
      const socket = net.connect(proxyPort(proxy.url), "127.0.0.1", () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        socket.resetAndDestroy();
      });
      socket.on("error", () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await tunnelViaProxy(proxy.url, authority, "/after-reset");
      expect(result.status).toBe("HTTP/1.1 200 Connection Established");
      expect(origin.hits).toEqual(["/after-reset"]);
    } finally {
      proxy.close();
      origin.server.stop(true);
    }
  });

  test("close() ends open tunnels", async () => {
    const origin = startOrigin();
    const proxy = await startBrowserProxy({ resolveAddress: resolveTestHosts });
    try {
      const socket = net.connect(proxyPort(proxy.url), "127.0.0.1");
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.on("error", () => undefined);
      await new Promise<void>((resolve) => {
        socket.once("data", () => resolve());
        const authority = `site.public.test:${origin.server.port}`;
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });

      proxy.close();
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      proxy.close();
      origin.server.stop(true);
    }
  });
});

describe("browser proxy in Chromium", () => {
  // Uses the production Chromium build and flags, so a Chromium or Puppeteer
  // upgrade that lets traffic bypass the proxy fails here.
  test.skipIf(process.platform !== "linux")(
    "keeps a page from reaching private addresses",
    async () => {
      const internal = startOrigin(
        () =>
          new Response("<h1>SECRET</h1>", { headers: { "content-type": "text/html" } })
      );
      let stunPackets = 0;
      const stun = await Bun.udpSocket({
        hostname: "127.0.0.1",
        socket: {
          data() {
            stunPackets += 1;
          },
        },
      });
      const page = startOrigin(
        () =>
          new Response(
            `<img id="public" src="/public.png">
             <img src="http://internal.test:${internal.server.port}/image">
             <iframe src="http://internal.test:${internal.server.port}/frame"></iframe>
             <script>
               fetch("http://internal.test:${internal.server.port}/fetch").catch(() => {});
               const peer = new RTCPeerConnection({
                 iceServers: [{ urls: "stun:127.0.0.1:${stun.port}" }],
               });
               peer.createDataChannel("probe");
               peer.createOffer().then((offer) => peer.setLocalDescription(offer));
             </script>`,
            { headers: { "content-type": "text/html" } }
          )
      );
      // The page host stands in for a public site; internal.test resolves to
      // 127.0.0.1 and goes through the real validation.
      const proxy = await startBrowserProxy({
        resolveAddress: async (url) =>
          new URL(url).hostname === "page.public.test"
            ? "127.0.0.1"
            : (
                await resolveSafeHttpUrl(url, {
                  lookupImpl: async () => [{ address: "127.0.0.1" }],
                })
              ).addresses[0],
      });
      const browser = await puppeteer.launch({
        executablePath: await Chromium.executablePath(),
        headless: "shell",
        args: [
          ...(await puppeteer.defaultArgs({ args: Chromium.args, headless: "shell" })),
          ...getBrowserProxyArgs(proxy.url),
        ],
      });
      try {
        const tab = await browser.newPage();
        // page.public.test is not in DNS, so loading it proves Chromium used
        // the proxy.
        const response = await tab.goto(`http://page.public.test:${page.server.port}/`, {
          waitUntil: "load",
          timeout: 15_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        expect(response?.status()).toBe(200);
        expect(page.hits).toContain("/public.png");

        // Loopback hosts would bypass a proxy without --proxy-bypass-list.
        await expect(
          tab.goto(`http://127.0.0.1:${internal.server.port}/direct`, { timeout: 10_000 })
        ).rejects.toThrow("net::ERR_");

        expect(internal.hits).toEqual([]);
        expect(stunPackets).toBe(0);
      } finally {
        await browser.close();
        proxy.close();
        stun.close();
        internal.server.stop(true);
        page.server.stop(true);
      }
    },
    60_000
  );
});
