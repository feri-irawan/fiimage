import { describe, expect, test } from "bun:test";
import {
  fetchSafeResponse,
  readResponseBody,
  RemoteBodyTooLargeError,
} from "../lib/remote";

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
