import { describe, expect, test } from "bun:test";
import {
  assertSafeHttpUrl,
  resolveSafeHttpUrl,
  UnsafeHttpUrlError,
} from "../lib/security";

describe("remote URL safety", () => {
  test.each([
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[0:0:0:0:0:ffff:7f00:1]",
    "http://[::127.0.0.1]",
    "http://[64:ff9b::7f00:1]",
    "http://[2001::1]",
    "http://[2002:7f00:1::1]",
    "http://localhost",
  ])("blocks %s", async (url) => {
    await expect(assertSafeHttpUrl(url)).rejects.toBeInstanceOf(
      UnsafeHttpUrlError
    );
  });

  test("allows a public literal IP without DNS", async () => {
    await expect(assertSafeHttpUrl("https://8.8.8.8/image.png")).resolves.toEqual(
      new URL("https://8.8.8.8/image.png")
    );
  });

  test("orders IPv4 addresses before IPv6 and keeps their order", async () => {
    const { addresses } = await resolveSafeHttpUrl("https://dual-stack.example/", {
      lookupImpl: async () => [
        { address: "2606:50c0:8000::154" },
        { address: "185.199.108.154" },
        { address: "2606:50c0:8001::154" },
        { address: "185.199.109.154" },
      ],
    });

    expect(addresses).toEqual([
      "185.199.108.154",
      "185.199.109.154",
      "2606:50c0:8000::154",
      "2606:50c0:8001::154",
    ]);
  });
});
