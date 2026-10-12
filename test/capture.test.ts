import { describe, expect, test } from "bun:test";
import { summarizeFailedRequests } from "../lib/capture";

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
