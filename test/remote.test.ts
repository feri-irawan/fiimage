import { describe, expect, test } from "bun:test";
import type { PeerCertificate } from "node:tls";
import {
  createPinnedRequest,
  fetchSafeResponse,
  readResponseBody,
  RemoteBodyTooLargeError,
} from "../lib/remote";
import { UpstreamRequestError } from "../lib/errors";

describe("safe remote fetch", () => {
  test("validates each redirect target", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchSafeResponse("https://8.8.8.8/start", { fetchImpl })
    ).rejects.toThrow("Private network URLs are not allowed.");
    expect(calls).toBe(1);
  });

  test("follows a public redirect", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://8.8.8.8/final" },
        });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;

    const response = await fetchSafeResponse("https://1.1.1.1/start", {
      fetchImpl,
    });
    expect(await response.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("retries transient upstream responses once", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 503 }) : new Response("ok");
    }) as unknown as typeof fetch;

    const response = await fetchSafeResponse("https://8.8.8.8/start", {
      fetchImpl,
    });

    expect(calls).toBe(2);
    expect(await response.text()).toBe("ok");
  });

  test("cancels intermediate redirect bodies", async () => {
    let cancelled = false;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: "https://8.8.8.8/final" } }
        );
      }
      return new Response("ok");
    }) as unknown as typeof fetch;

    await fetchSafeResponse("https://1.1.1.1/start", { fetchImpl });
    expect(cancelled).toBe(true);
  });

  test("reports unreachable hosts as upstream errors", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      fetchSafeResponse("https://8.8.8.8/start", { fetchImpl })
    ).rejects.toBeInstanceOf(UpstreamRequestError);
    expect(calls).toBe(2);
  });

  test.each([
    ["a missing Location header", undefined],
    ["an unparsable Location header", "http://["],
  ])("reports redirects with %s as upstream errors", async (_, location) => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: location === undefined ? {} : { location },
      })) as unknown as typeof fetch;

    await expect(
      fetchSafeResponse("https://8.8.8.8/start", { fetchImpl })
    ).rejects.toThrow(
      new UpstreamRequestError("Remote URL returned an invalid redirect.")
    );
  });

  test("reports redirect loops as upstream errors", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://8.8.8.8/loop" },
      })) as unknown as typeof fetch;

    await expect(
      fetchSafeResponse("https://8.8.8.8/start", { fetchImpl })
    ).rejects.toThrow(
      new UpstreamRequestError("Remote URL redirected too many times.")
    );
  });

  test("caps chunked response bodies", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    });

    await expect(readResponseBody(new Response(body), 4)).rejects.toBeInstanceOf(
      RemoteBodyTooLargeError
    );
  });

  test("times out a slow response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readResponseBody(new Response(body), 100, { timeoutMs: 5 })
    ).rejects.toThrow("Remote response body timed out.");
    expect(cancelled).toBe(true);
  });
});

describe("DNS pinning", () => {
  const lookupImpl = (addresses: string[]) => async () =>
    addresses.map((address) => ({ address }));

  type Captured = { input: string; init: BunFetchRequestInit };
  const capturingFetch = (calls: Captured[], fail = 0) =>
    (async (input: string, init: BunFetchRequestInit) => {
      calls.push({ input, init });
      if (calls.length <= fail) throw new TypeError("connection refused");
      return new Response("ok");
    }) as unknown as typeof fetch;

  test("connects to the validated address with the original Host and TLS name", async () => {
    const calls: Captured[] = [];

    const response = await fetchSafeResponse("https://example.com/path?q=1", {
      fetchImpl: capturingFetch(calls),
      lookupImpl: lookupImpl(["93.184.216.34"]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://93.184.216.34/path?q=1");
    expect(new Headers(calls[0].init.headers).get("host")).toBe("example.com");
    expect(calls[0].init.tls?.serverName).toBe("example.com");
    expect(response.url).toBe("https://example.com/path?q=1");
  });

  test("verifies certificates against the hostname, not the pinned IP", () => {
    const [, init] = createPinnedRequest("https://example.com/", "93.184.216.34", undefined);
    const verify = (init as BunFetchRequestInit).tls!.checkServerIdentity!;
    const certificate = (altName: string) =>
      ({ subject: { CN: altName }, subjectaltname: `DNS:${altName}` }) as PeerCertificate;

    expect(verify("93.184.216.34", certificate("example.com"))).toBeUndefined();
    expect(verify("93.184.216.34", certificate("attacker.test"))).toBeInstanceOf(Error);
  });

  test("keeps the port in the Host header and skips TLS options for HTTP", () => {
    const [input, init] = createPinnedRequest("http://example.com:8080/a", "93.184.216.34", {
      Accept: "text/html",
    });
    const headers = new Headers(init?.headers);

    expect(input).toBe("http://93.184.216.34:8080/a");
    expect(headers.get("host")).toBe("example.com:8080");
    expect(headers.get("accept")).toBe("text/html");
    expect((init as BunFetchRequestInit).tls).toBeUndefined();
  });

  test("brackets pinned IPv6 addresses", () => {
    const [input] = createPinnedRequest("https://example.com/", "2606:2800:220:1::1", undefined);

    expect(input).toBe("https://[2606:2800:220:1::1]/");
  });

  test("leaves literal IP URLs unchanged", () => {
    const [input, init] = createPinnedRequest("https://8.8.8.8/a", "8.8.8.8", undefined);

    expect(input).toBe("https://8.8.8.8/a");
    expect(new Headers(init?.headers).has("host")).toBe(false);
  });

  test("retries a failed connection on the next validated address", async () => {
    const calls: Captured[] = [];

    await fetchSafeResponse("https://example.com/", {
      fetchImpl: capturingFetch(calls, 1),
      lookupImpl: lookupImpl(["93.184.216.34", "93.184.216.35"]),
    });

    expect(calls.map(({ input }) => input)).toEqual([
      "https://93.184.216.34/",
      "https://93.184.216.35/",
    ]);
  });

  test("rejects a hostname when any resolved address is private", async () => {
    const calls: Captured[] = [];

    await expect(
      fetchSafeResponse("https://rebind.example/", {
        fetchImpl: capturingFetch(calls),
        lookupImpl: lookupImpl(["93.184.216.34", "127.0.0.1"]),
      })
    ).rejects.toThrow("Private network URLs are not allowed.");
    expect(calls).toHaveLength(0);
  });

  test("Bun sends the pinned Host header on the wire", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new Response(request.headers.get("host")),
    });
    try {
      const [input, init] = createPinnedRequest(
        `http://pinned.example:${server.port}/`,
        "127.0.0.1",
        undefined
      );
      const response = await fetch(input, init);

      expect(await response.text()).toBe(`pinned.example:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  // Guards the Bun TLS behaviour pinning relies on: SNI and certificate checks
  // use the original hostname even though the connection targets an IP.
  test.skipIf(!Bun.which("openssl"))(
    "Bun verifies pinned HTTPS connections against the hostname",
    async () => {
      const dir = `/tmp/fiimage-tls-${crypto.randomUUID()}`;
      const openssl = async (...args: string[]) => {
        const process = Bun.spawn({
          cmd: ["openssl", ...args],
          cwd: dir,
          stdout: "ignore",
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([
          new Response(process.stderr).text(),
          process.exited,
        ]);
        if (exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${stderr}`);
      };
      const issue = async (hostname: string) => {
        await openssl(
          "req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`,
          "-keyout", `${hostname}.key`, "-out", `${hostname}.csr`
        );
        await Bun.write(`${dir}/${hostname}.ext`, `subjectAltName=DNS:${hostname}`);
        await openssl(
          "x509", "-req", "-in", `${hostname}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
          "-CAcreateserial", "-days", "1", "-extfile", `${hostname}.ext`,
          "-out", `${hostname}.crt`
        );
      };
      const serve = (hostname: string) =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          tls: {
            cert: Bun.file(`${dir}/${hostname}.crt`),
            key: Bun.file(`${dir}/${hostname}.key`),
          },
          fetch: (request) => new Response(request.headers.get("host")),
        });

      await Bun.$`mkdir -p ${dir}`;
      const servers: ReturnType<typeof serve>[] = [];
      try {
        await openssl(
          "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
          "-subj", "/CN=fiimage test CA", "-keyout", "ca.key", "-out", "ca.crt"
        );
        await issue("pinned.example");
        await issue("attacker.example");
        const ca = await Bun.file(`${dir}/ca.crt`).text();
        const trusted = serve("pinned.example");
        const impostor = serve("attacker.example");
        servers.push(trusted, impostor);

        // Both servers listen on 127.0.0.1; only the trusted one holds a
        // certificate for pinned.example.
        const request = (port: number | undefined) => {
          const [input, init] = createPinnedRequest(
            `https://pinned.example:${port}/`,
            "127.0.0.1",
            undefined
          );
          const pinnedInit = init as BunFetchRequestInit;
          return fetch(input, { ...pinnedInit, tls: { ...pinnedInit.tls, ca } });
        };

        const response = await request(trusted.port);
        expect(await response.text()).toBe(`pinned.example:${trusted.port}`);
        await expect(request(impostor.port)).rejects.toMatchObject({
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
      } finally {
        for (const server of servers) server.stop(true);
        await Bun.$`rm -rf ${dir}`.quiet();
      }
    },
    20_000
  );
});
