/**
 * Open Graph
 */

import { load } from "cheerio";
import { Request, Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import parse from "html-react-parser";
import { z } from "zod";
import inlineCss from "inline-css";
import { Resvg } from "@resvg/resvg-js";
import { sendGeneratedImage } from "./response";
import { fetchSafeResponse, readResponseBody } from "./remote";
import { UnsafeHttpUrlError } from "./security";
import { httpUrlSchema } from "./validation";
import { generationGate } from "./concurrency";
import { PayloadTooLargeError, UpstreamResponseError } from "./errors";
import { withDeadline } from "./timing";

/**
 * Route handler `/og`
 * @param req
 * @param res
 */
export const createOGImage = async (req: Request, res: Response) => {
  try {
    const query = querySchema.parse(req.query);
    const release = generationGate.tryAcquire();
    if (!release) {
      res.status(429).json({ error: "Too many image generations are in progress." });
      return;
    }

    try {
      const deadlineAt = Date.now() + OG_TIMEOUT_MS;
      const metadata = await getPageMetadata(query.url, deadlineAt);
      const png = await renderOGImage(metadata, query.template, deadlineAt);

      sendGeneratedImage(res, "image/png", png);
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(z.prettifyError(error));
      res.status(400).json(z.flattenError(error));
      return;
    }
    if (error instanceof UnsafeHttpUrlError) {
      res.status(400).json({ error: error.message });
      return;
    }

    throw error;
  }
};

/**
 * Query string Validation
 */
const templateSchema = z.enum(["0", "1"]).default("0");
const querySchema = z.object({
  url: httpUrlSchema,
  template: templateSchema,
});

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_ICON_PIXELS = 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const OG_TIMEOUT_MS = 50_000;
const templateCache = new Map<string, string>();
const fonts = [
  {
    name: "Inter",
    data: readFileSync(resolve("fonts/inter-regular.otf")),
    weight: 400 as const,
    style: "normal" as const,
  },
  {
    name: "Inter",
    data: readFileSync(resolve("fonts/inter-bold.otf")),
    weight: 700 as const,
    style: "normal" as const,
  },
];

/** Load Satori after its CJS compression dependency is available. */
const loadSatori = async () => {
  await import("fflate");
  return (await import("satori")).default;
};

export type TMetadata = {
  title: string;
  description?: string;
  url?: string;
  icon?: string;
};

/** Icon links in preference order; touch icons are usually larger PNGs. */
const ICON_SELECTORS = [
  'link[rel~="apple-touch-icon" i]',
  'link[rel~="apple-touch-icon-precomposed" i]',
  'link[rel~="icon" i]',
];
const MAX_ICON_CANDIDATES = 3;

/** Read `charset=` from a Content-Type header value. */
const getCharsetParameter = (contentType: string) =>
  /charset\s*=\s*["']?([^\s"';]+)/i.exec(contentType)?.[1];

/** Detect the encoding from a byte-order mark. */
const getBomEncoding = (body: Uint8Array) => {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
};

/**
 * Find `<meta charset>` or `<meta http-equiv content="...; charset=">` in the
 * first 1024 bytes, like the HTML encoding prescan.
 */
const getMetaCharset = (body: Uint8Array) => {
  const head = new TextDecoder("windows-1252").decode(body.subarray(0, 1024));
  const charset = /<meta\s[^>]*?charset\s*=\s*["']?\s*([^\s"'/>;]+)/i.exec(head)?.[1];
  // A document that could be read as ASCII to find this tag is not UTF-16.
  return charset?.toLowerCase().startsWith("utf-16") ? "utf-8" : charset;
};

/** Decode HTML with its BOM, HTTP charset, or `<meta>` charset, else UTF-8. */
export const decodeHtml = (body: Uint8Array, contentType = "") => {
  const label =
    getBomEncoding(body) ??
    getCharsetParameter(contentType) ??
    getMetaCharset(body) ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    // Unknown labels throw a RangeError.
    return new TextDecoder().decode(body);
  }
};

/** Collapse whitespace and cap the length without splitting characters. */
const cleanText = (value: string | undefined, maxLength: number) => {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return;
  const characters = Array.from(text);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : text;
};

/** Show the page URL without query strings or fragments such as UTM tags. */
const formatDisplayUrl = (url: string) => {
  const displayUrl = new URL(url);
  displayUrl.search = "";
  displayUrl.hash = "";
  const text = displayUrl.toString();
  return displayUrl.pathname === "/" ? text.slice(0, -1) : text;
};

/** Extract the title, description, and icon candidates from a page. */
export const parsePageMetadata = (html: string, pageUrl: string) => {
  const $ = load(html);
  const meta = (...keys: string[]) => {
    for (const key of keys) {
      const content = $(`meta[property="${key}" i], meta[name="${key}" i]`)
        .first()
        .attr("content");
      if (content?.trim()) return content;
    }
  };

  const iconUrls = new Set<string>();
  for (const selector of ICON_SELECTORS) {
    $(selector).each((_, element) => {
      const iconUrl = createValidIconUrl(pageUrl, $(element).attr("href") || "");
      if (iconUrl) iconUrls.add(iconUrl);
    });
  }

  return {
    title:
      cleanText(meta("og:title", "twitter:title"), MAX_TITLE_LENGTH) ??
      cleanText($("title").first().text(), MAX_TITLE_LENGTH) ??
      new URL(pageUrl).hostname,
    description: cleanText(
      meta("og:description", "twitter:description", "description"),
      MAX_DESCRIPTION_LENGTH
    ),
    iconUrls: [...iconUrls].slice(0, MAX_ICON_CANDIDATES),
  };
};

/**
 * Get the page metadata
 * @param url
 * @returns Metadata object
 */
export const getPageMetadata = async (
  url: string,
  deadlineAt: number,
  fetchImpl: typeof fetch = fetch
): Promise<TMetadata> => {
  const pageDeadlineAt = Math.min(deadlineAt, Date.now() + 10_000);
  const response = await fetchSafeResponse(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    timeoutMs: Math.max(1, pageDeadlineAt - Date.now()),
    fetchImpl,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamResponseError(
      response.status,
      `Unable to fetch page (HTTP ${response.status}).`
    );
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_HTML_BYTES) {
    await response.body?.cancel();
    throw new PayloadTooLargeError("Remote page is too large.");
  }

  const body = await readResponseBody(response, MAX_HTML_BYTES, {
    timeoutMs: Math.max(1, pageDeadlineAt - Date.now()),
  });

  const html = decodeHtml(body, response.headers.get("content-type") || "");
  const { title, description, iconUrls } = parsePageMetadata(
    html,
    response.url || url
  );

  // Try the next candidate when an icon is missing or in an unsupported format.
  let icon: string | undefined;
  for (const iconUrl of iconUrls) {
    if (pageDeadlineAt <= Date.now()) break;
    icon = await fetchIconDataUrl(
      iconUrl,
      Math.max(1, pageDeadlineAt - Date.now()),
      fetchImpl
    );
    if (icon) break;
  }

  return { title, description, icon, url: formatDisplayUrl(url) };
};

/** Create a valid icon URL */
const createValidIconUrl = (url: string, icon: string) => {
  if (!icon) return;

  let iconUrl: URL;
  try {
    iconUrl = new URL(icon, url);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(iconUrl.protocol)) return;

  // Do not proxy ICOs through this service. That would create an indirect
  // fetch path whose nested URL is no longer visible to this request.
  // SVG icons cannot be decoded by Bun.Image, so skip the fetch.
  const pathname = iconUrl.pathname.toLowerCase();
  if (pathname.endsWith(".ico") || pathname.endsWith(".svg")) return;

  return iconUrl.toString();
};

/** Fetch optional favicon bytes safely; a bad icon should not break OG output. */
const fetchIconDataUrl = async (
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
) => {
  try {
    const response = await fetchSafeResponse(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
      timeoutMs,
      fetchImpl,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }

    const contentType = (response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) {
      await response.body?.cancel();
      return;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_ICON_BYTES) {
      await response.body?.cancel();
      return;
    }

    const body = await readResponseBody(response, MAX_ICON_BYTES, {
      timeoutMs,
    });
    if (body.length === 0) return;

    const image = new Bun.Image(body, {
      autoOrient: true,
      maxPixels: MAX_ICON_PIXELS,
    });
    const png = await image.png().buffer();
    if (png.length > MAX_ICON_BYTES) return;
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return;
  }
};

/** Render page metadata into a 1200x630 PNG with the chosen template. */
export const renderOGImage = async (
  metadata: TMetadata,
  template: z.infer<typeof templateSchema> = "0",
  deadlineAt = Date.now() + OG_TIMEOUT_MS
) => {
  const htmlObject = parse(await useTheTemplate(metadata, template));
  const svg = await withDeadline(
    createSVGFromHTMLObject(htmlObject),
    deadlineAt,
    "Open Graph SVG generation timed out."
  );
  return await withDeadline(
    createPNGFromSVG(svg),
    deadlineAt,
    "Open Graph PNG generation timed out."
  );
};

/**
 * Use Template
 * @param metadata
 * @param template
 * @returns HTML string
 */
const useTheTemplate = async (
  metadata: TMetadata,
  template: z.infer<typeof templateSchema> = "0"
) => {
  let html = templateCache.get(template);
  if (!html) {
    html = await inlineCss(
      readFileSync(resolve(`templates/og/${template}.html`), "utf-8"),
      { url: "/" }
    );
    templateCache.set(template, html);
  }

  // Load the template
  // @ts-ignore
  const $ = load(html, null, false);

  // Populate meta data to HTML
  $("#title").text(metadata.title);
  $("#description").text(metadata.description || "");
  $("#url").text(metadata.url || "");

  if (!metadata.icon) $("#icon").remove();
  else $("#icon").attr("src", metadata.icon);

  return $.html().trim();
};

/**
 * Create SVG from HTML
 * @param htmlObject
 * @returns SVG string
 */
const createSVGFromHTMLObject = async (htmlObject: any) => {
  const satori = await loadSatori();
  return await satori(htmlObject, {
    width: 600,
    height: 315,
    fonts,
  });
};

const createPNGFromSVG = async (svg: string) => {
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
    .render()
    .asPng();
};
