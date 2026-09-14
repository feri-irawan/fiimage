import { describe, expect, test } from "bun:test";
import { assertSafeHttpUrl, UnsafeHttpUrlError } from "../lib/security";

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
});
