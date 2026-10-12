import http from "node:http";
import net from "node:net";
import { HostLookup, resolveSafeHttpUrl, UnsafeHttpUrlError } from "./security";

/** Headers that describe one connection and must not be forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

const withoutHopByHop = (rawHeaders: string[]) => {
  const headers: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (HOP_BY_HOP_HEADERS.has(rawHeaders[index].toLowerCase())) continue;
    headers.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return headers;
};

type BrowserProxyOptions = {
  /** DNS lookup, replaceable in tests. */
  lookupImpl?: HostLookup;
  /** Resolve a URL to the addresses to try, in order; replaceable in tests. */
  resolveAddresses?: (url: string) => Promise<string[]>;
};

// Long enough for a slow handshake, short enough that an unreachable address
// (such as IPv6 on a host without IPv6 egress) leaves time for the next one.
const CONNECT_ATTEMPT_TIMEOUT_MS = 4_000;

/**
 * Connect to the first reachable address, like a browser falling back between
 * the addresses of a host. Every address has already been validated.
 */
const connectToFirstReachable = async (
  addresses: string[],
  port: number,
  track: (socket: net.Socket) => net.Socket
) => {
  let lastError: unknown = new Error("No addresses to connect to.");
  for (const address of addresses) {
    const socket = track(net.connect({ host: address, port }));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Connecting to ${address} timed out.`)),
          CONNECT_ATTEMPT_TIMEOUT_MS
        );
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return socket;
    } catch (error) {
      socket.destroy();
      lastError = error;
    }
  }
  throw lastError;
};

/** Chromium flags that send all of the browser's traffic through the proxy. */
export const getBrowserProxyArgs = (proxyUrl: string) => [
  `--proxy-server=${proxyUrl}`,
  // Chromium sends loopback hosts direct by default; send them to the proxy
  // too so they are rejected like every other private address.
  "--proxy-bypass-list=<-loopback>",
  // WebRTC would otherwise send UDP straight to any address, such as STUN
  // requests to 127.0.0.1, without going through the proxy.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

export type BrowserProxy = {
  /** Value for Chromium's `--proxy-server` flag. */
  url: string;
  close: () => void;
};

/**
 * Start a local HTTP proxy for Chromium that resolves each target once,
 * rejects private addresses, and connects to exactly the validated address.
 *
 * Without it, the request-interception check and Chromium each resolve DNS
 * separately, so a DNS rebinding answer could hand Chromium a private
 * address after the check passed. HTTPS goes through CONNECT tunnels, so TLS
 * stays end to end and Chromium still verifies certificates for the hostname.
 */
export const startBrowserProxy = async ({
  lookupImpl,
  resolveAddresses = async (url) =>
    (await resolveSafeHttpUrl(url, { lookupImpl })).addresses,
}: BrowserProxyOptions = {}): Promise<BrowserProxy> => {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  // Plain HTTP arrives as an absolute-form request: GET http://host/path.
  const server = http.createServer(async (request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("Unsupported protocol.");
    } catch {
      response.writeHead(400).end();
      return;
    }

    let socket: net.Socket;
    try {
      const addresses = await resolveAddresses(target.toString());
      socket = await connectToFirstReachable(addresses, Number(target.port || 80), track);
    } catch {
      // Close without a response so Chromium reports a network error rather
      // than rendering a proxy error page into the screenshot.
      response.destroy();
      return;
    }
    if (response.destroyed) {
      socket.destroy();
      return;
    }

    const upstream = http.request(
      {
        createConnection: () => socket,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        // The original Host header is forwarded with the other headers.
        headers: withoutHopByHop(request.rawHeaders),
        setHost: false,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          withoutHopByHop(upstreamResponse.rawHeaders)
        );
        upstreamResponse.pipe(response);
      }
    );
    upstream.once("error", () => response.destroy());
    request.pipe(upstream);
  });

  server.on("connection", track);

  // HTTPS arrives as CONNECT host:port and is tunnelled byte for byte.
  server.on("connect", async (request, client: net.Socket, head: Buffer) => {
    let upstream: net.Socket | undefined;
    // The browser may reset the tunnel at any point, including while DNS is
    // still resolving; never open or keep an upstream connection for it.
    client.on("error", () => upstream?.destroy());
    const authority = request.url ?? "";
    let port: number;
    try {
      port = Number(new URL(`https://${authority}`).port || 443);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    try {
      const addresses = await resolveAddresses(`https://${authority}/`);
      upstream = await connectToFirstReachable(addresses, port, track);
    } catch (error) {
      const status =
        error instanceof UnsafeHttpUrlError ? "403 Forbidden" : "502 Bad Gateway";
      client.end(`HTTP/1.1 ${status}\r\n\r\n`);
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.once("error", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
};
