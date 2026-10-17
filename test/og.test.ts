import { describe, expect, test } from "bun:test";
import {
  decodeHtml,
  FIIMAGE_FETCH_HEADER,
  getAddressParts,
  getCoverSize,
  getPageMetadata,
  parsePageMetadata,
  renderOGImage,
} from "../lib/og";

const encode = (text: string) => new TextEncoder().encode(text);
// "Café" with é as the single byte 0xE9, as in ISO-8859-1 / windows-1252.
const latin1Cafe = (before: string, after = "") =>
  Uint8Array.from([...encode(`${before}Caf`), 0xe9, ...encode(after)]);

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
);
// A photo-sized JPEG, scaled up from the 1x1 PNG.
const photoJpeg = new Bun.Image(png)
  .resize(1600, 900)
  .jpeg()
  .buffer()
  .then((buffer) => new Uint8Array(buffer));

describe("HTML decoding", () => {
  test("uses the charset from the Content-Type header", () => {
    expect(decodeHtml(latin1Cafe(""), "text/html; charset=ISO-8859-1")).toBe("Café");
  });

  test("uses <meta charset> when the header has no charset", () => {
    const html = decodeHtml(latin1Cafe('<meta charset="iso-8859-1"><title>'), "text/html");
    expect(html).toContain("Café");
  });

  test("uses <meta http-equiv> content charsets", () => {
    const html = decodeHtml(
      latin1Cafe('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">')
    );
    expect(html).toContain("Café");
  });

  test("prefers a byte-order mark over the header", () => {
    const body = Uint8Array.from([0xef, 0xbb, 0xbf, ...encode("Café")]);
    expect(decodeHtml(body, "text/html; charset=iso-8859-1")).toBe("Café");
  });

  test("treats a <meta> UTF-16 declaration as UTF-8", () => {
    expect(decodeHtml(encode('<meta charset="utf-16">Café'))).toContain("Café");
  });

  test("falls back to UTF-8 for unknown or missing charsets", () => {
    expect(decodeHtml(encode("Café"), "text/html; charset=bogus")).toBe("Café");
    expect(decodeHtml(encode("Café"))).toBe("Café");
  });
});

describe("page metadata parsing", () => {
  const pageUrl = "https://example.com/blog/post";

  test("prefers Open Graph, then Twitter, then document tags", () => {
    const metadata = parsePageMetadata(
      `<title>Document title</title>
       <meta name="twitter:title" content="Twitter title">
       <meta property="og:title" content="OG title">
       <meta name="description" content="Meta description">
       <meta name="twitter:description" content="Twitter description">`,
      pageUrl
    );

    expect(metadata.title).toBe("OG title");
    expect(metadata.description).toBe("Twitter description");
  });

  test("ignores blank tags and collapses whitespace", () => {
    const metadata = parsePageMetadata(
      `<meta property="og:title" content="  ">
       <title>
         A   multi-line
         title </title>
       <meta name="Description" content=" Plain   description ">`,
      pageUrl
    );

    expect(metadata.title).toBe("A multi-line title");
    expect(metadata.description).toBe("Plain description");
  });

  test("falls back to the hostname when the page has no title", () => {
    const metadata = parsePageMetadata("<p>No head</p>", pageUrl);

    expect(metadata.title).toBe("example.com");
    expect(metadata.description).toBeUndefined();
  });

  test("truncates long titles with an ellipsis", () => {
    const { title } = parsePageMetadata(`<title>${"a".repeat(300)}</title>`, pageUrl);

    expect(Array.from(title)).toHaveLength(200);
    expect(title.endsWith("…")).toBe(true);
  });

  test("orders icon candidates and skips ICO and SVG files", () => {
    const { iconUrls } = parsePageMetadata(
      `<link rel="icon" href="/favicon.ico">
       <link rel="icon" type="image/svg+xml" href="/icon.svg">
       <link rel="shortcut icon" href="/icon-32.png">
       <link rel="mask-icon" href="/mask.png">
       <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
       <link rel="icon" href="/icon-64.png">
       <link rel="icon" href="/icon-128.png">`,
      pageUrl
    );

    expect(iconUrls).toEqual([
      "https://cdn.example.com/touch.png",
      "https://example.com/icon-32.png",
      "https://example.com/icon-64.png",
    ]);
  });

  test("orders photo candidates and skips SVGs, fiimage images, and small images", () => {
    const { photoUrls } = parsePageMetadata(
      `<meta property="og:image" content="https://fiimage.vercel.app/og?url=https://example.com">
       <meta property="og:image" content="/cover.svg">
       <meta name="twitter:image" content="/cover.jpg">
       <img src="/logo.png" width="64" height="64">
       <img src="/outside.jpg">
       <article><img src="data:image/gif;base64,R0lGOD" data-src="/lazy.jpg"></article>`,
      pageUrl
    );

    expect(photoUrls).toEqual([
      "https://example.com/cover.jpg",
      "https://example.com/lazy.jpg",
      "https://example.com/outside.jpg",
    ]);
  });

  test("takes the first srcset candidate and caps photo candidates", () => {
    const { photoUrls } = parsePageMetadata(
      `<main><img srcset="/a-480.jpg 480w, /a-960.jpg 960w"></main>
       <img src="/b.jpg"><img src="/c.jpg"><img src="/d.jpg">`,
      pageUrl
    );

    expect(photoUrls).toEqual([
      "https://example.com/a-480.jpg",
      "https://example.com/b.jpg",
      "https://example.com/c.jpg",
    ]);
  });
});

describe("photo sizing", () => {
  test.each([
    [4000, 3000, 1200, 900],
    [5000, 1000, 3150, 630],
    [2400, 1260, 1200, 630],
    [800, 1400, 800, 1400],
  ])("scales %ix%i to %ix%i to cover 1200x630, never up", (width, height, coverWidth, coverHeight) => {
    expect(getCoverSize(width, height, { width: 1200, height: 630 })).toEqual({
      width: coverWidth,
      height: coverHeight,
    });
  });
});

describe("page metadata fetching", () => {
  test("decodes the page, strips tracking from the URL, and falls back between icons", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      if (url.endsWith("/missing.png")) return new Response(null, { status: 404 });
      if (url.endsWith("/icon.png")) {
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      return new Response(
        latin1Cafe(
          '<link rel="apple-touch-icon" href="/missing.png"><link rel="icon" href="/icon.png"><title>',
          "</title>"
        ),
        { headers: { "content-type": "text/html; charset=iso-8859-1" } }
      );
    }) as unknown as typeof fetch;

    const metadata = await getPageMetadata(
      "https://8.8.8.8/post/?utm_source=newsletter#comments",
      Date.now() + 10_000,
      fetchImpl
    );

    expect(metadata.title).toBe("Café");
    expect(metadata.url).toBe("https://8.8.8.8/post/");
    expect(metadata.icon?.startsWith("data:image/png;base64,")).toBe(true);
    expect(requested.slice(1)).toEqual([
      "https://8.8.8.8/missing.png",
      "https://8.8.8.8/icon.png",
    ]);
  });

  test("fetches a photo only when asked, trying an explicit photo first", async () => {
    const requests: { path: string; marked: boolean }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);
      requests.push({ path: pathname, marked: new Headers(init?.headers).has(FIIMAGE_FETCH_HEADER) });
      if (pathname === "/explicit.jpg") return new Response(null, { status: 404 });
      if (pathname === "/cover.jpg") {
        return new Response(await photoJpeg, { headers: { "content-type": "image/jpeg" } });
      }
      return new Response('<title>Post</title><meta property="og:image" content="/cover.jpg">', {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const plain = await getPageMetadata("https://8.8.8.8/post", Date.now() + 10_000, fetchImpl);
    expect(plain.photo).toBeUndefined();
    expect(requests.map(({ path }) => path)).toEqual(["/post"]);

    requests.length = 0;
    const metadata = await getPageMetadata(
      "https://8.8.8.8/post",
      Date.now() + 10_000,
      fetchImpl,
      { withPhoto: true, photoUrl: "https://8.8.8.8/explicit.jpg" }
    );

    expect(metadata.photo?.startsWith("data:image/jpeg;base64,")).toBe(true);
    const { width, height } = await new Bun.Image(
      Buffer.from(metadata.photo!.split(",")[1], "base64")
    ).metadata();
    expect([width, height]).toEqual([1200, 675]);
    expect(requests).toEqual([
      { path: "/post", marked: false },
      { path: "/explicit.jpg", marked: true },
      { path: "/cover.jpg", marked: true },
    ]);
  });

  test("skips icons when asked", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(new URL(url).pathname);
      return new Response('<link rel="icon" href="/icon.png"><title>Home</title>', {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const metadata = await getPageMetadata("https://8.8.8.8/", Date.now() + 10_000, fetchImpl, {
      withIcon: false,
    });

    expect(metadata.icon).toBeUndefined();
    expect(requested).toEqual(["/"]);
  });

  test("shows a bare origin without a trailing slash", async () => {
    const fetchImpl = (async () =>
      new Response("<title>Home</title>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const metadata = await getPageMetadata("https://8.8.8.8/?ref=x", Date.now() + 10_000, fetchImpl);

    expect(metadata.url).toBe("https://8.8.8.8");
  });
});

describe("page address parts", () => {
  test.each([
    ["https://www.github.com/feri-irawan/fiimage/", "github.com", "/feri-irawan/fiimage"],
    ["https://example.com", "example.com", ""],
    ["https://xn--bcher-kva.example/caf%C3%A9", "bücher.example", "/café"],
    ["https://example.com/bad%E0%A4%A", "example.com", "/bad%E0%A4%A"],
    ["not a url", "", ""],
  ])("splits %s", (url, host, path) => {
    expect(getAddressParts(url)).toEqual({ host, path });
  });
});

describe("Open Graph rendering", () => {
  const icon = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const templates = ["0", "1", "2", "3", "4", "5", "6", "7", "8"] as const;

  test.each(
    templates.flatMap((template) => [
      [template, false],
      [template, true],
    ])
  )("renders template %s (with images: %p) as a 1200x630 PNG", async (template, withImages) => {
    const output = await renderOGImage(
      {
        title: "Café crème: a fairly long title that should wrap onto two lines",
        description: "A description for the Open Graph image.",
        url: "https://example.com/blog/post",
        icon: withImages ? icon : undefined,
        photo: withImages
          ? `data:image/jpeg;base64,${Buffer.from(await photoJpeg).toString("base64")}`
          : undefined,
      },
      template
    );
    const metadata = await new Bun.Image(output).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  }, 20_000);
});
