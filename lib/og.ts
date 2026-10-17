/**
 * Open Graph
 */

import { load } from "cheerio";
import { Request, Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import { domainToUnicode } from "url";
import parse from "html-react-parser";
import { z } from "zod";
import inlineCss from "inline-css";
import { Resvg } from "@resvg/resvg-js";
import { sendGeneratedImage, sendTooManyRequests } from "./response";
import { fetchSafeResponse, readResponseBody } from "./remote";
import { UnsafeHttpUrlError } from "./security";
import { httpUrlSchema, imageUrlSchema } from "./validation";
import { MAX_SOURCE_PIXELS } from "./image";
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
      sendTooManyRequests(res);
      return;
    }

    try {
      const deadlineAt = Date.now() + OG_TIMEOUT_MS;
      // When a page's icon or photo points back at this service, the nested
      // request skips images so the two cannot keep requesting each other.
      const nested = Boolean(req.get(FIIMAGE_FETCH_HEADER));
      const metadata = await getPageMetadata(query.url, deadlineAt, fetch, {
        withIcon: !nested,
        withPhoto: !nested && PHOTO_TEMPLATES.has(query.template),
        photoUrl: query.image,
      });
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
const templateSchema = z
  .enum(["0", "1", "2", "3", "4", "5", "6", "7", "8"])
  .default("0");
const querySchema = z.object({
  url: httpUrlSchema,
  template: templateSchema,
  image: imageUrlSchema,
});

/** Templates that show a photo from the page. */
const PHOTO_TEMPLATES = new Set<string>(["8"]);
/** Sent with icon and photo requests, so fiimage can tell when it is fetching itself. */
export const FIIMAGE_FETCH_HEADER = "x-fiimage-fetch";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_ICON_PIXELS = 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_CANDIDATES = 3;
/** Smaller images are usually icons, avatars, or tracking pixels. */
const MIN_CONTENT_IMAGE_SIZE = 200;
/** Photos fill the whole image, so they only need to cover 1200x630. */
const PHOTO_SIZE = { width: 1200, height: 630 };
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const OG_TIMEOUT_MS = 50_000;
const templateCache = new Map<string, string>();
const loadFont = (
  file: string,
  name: string,
  weight: 400 | 700,
  style: "normal" | "italic" = "normal"
) => ({ name, data: readFileSync(resolve(`fonts/${file}`)), weight, style });

const fonts = [
  loadFont("instrument-sans-regular.ttf", "Instrument Sans", 400),
  loadFont("instrument-sans-bold.ttf", "Instrument Sans", 700),
  loadFont("instrument-sans-condensed-bold.ttf", "Instrument Sans Condensed", 700),
  loadFont("instrument-serif-regular.ttf", "Instrument Serif", 400),
  loadFont("instrument-serif-italic.ttf", "Instrument Serif", 400, "italic"),
  loadFont("jetbrains-mono-regular.ttf", "JetBrains Mono", 400),
  loadFont("jetbrains-mono-bold.ttf", "JetBrains Mono", 700),
  // Templates fall back to Inter for scripts the faces above lack, such as
  // Cyrillic and Greek.
  loadFont("inter-regular.otf", "Inter", 400),
  loadFont("inter-bold.otf", "Inter", 700),
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
  photo?: string;
};

/** Page image tags in preference order. */
const PHOTO_META_KEYS = [
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
];

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

/**
 * Split a page URL into the readable host and path that templates show
 * separately, such as `github.com` and `/feri-irawan/fiimage`.
 */
export const getAddressParts = (url = "") => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: "", path: "" };
  }

  let path = parsed.pathname.replace(/\/$/, "");
  try {
    path = decodeURI(path);
  } catch {
    // Keep a malformed escape as it is.
  }
  const host = domainToUnicode(parsed.hostname) || parsed.hostname;
  return { host: host.replace(/^www\./, ""), path };
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

  const photoUrls = new Set<string>();
  const addPhoto = (value?: string) => {
    const photoUrl = createValidPhotoUrl(pageUrl, value?.trim() || "");
    if (photoUrl && photoUrls.size < MAX_PHOTO_CANDIDATES) photoUrls.add(photoUrl);
  };
  for (const key of PHOTO_META_KEYS) {
    $(`meta[property="${key}" i], meta[name="${key}" i]`).each((_, element) =>
      addPhoto($(element).attr("content"))
    );
  }
  $('link[rel~="image_src" i]').each((_, element) => addPhoto($(element).attr("href")));
  // Then images in the page itself, the article's own first.
  for (const selector of ["article img", "main img", "img"]) {
    $(selector).each((_, element) => {
      const image = $(element);
      const width = Number(image.attr("width"));
      const height = Number(image.attr("height"));
      if (width < MIN_CONTENT_IMAGE_SIZE || height < MIN_CONTENT_IMAGE_SIZE) return;
      // Lazy-loaded images keep the real address in data-src.
      const srcset = image.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
      addPhoto(image.attr("data-src") || image.attr("src") || srcset);
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
    photoUrls: [...photoUrls],
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
  fetchImpl: typeof fetch = fetch,
  {
    withIcon = true,
    withPhoto = false,
    photoUrl,
  }: {
    /** Fetch the site icon; requests fiimage makes to itself skip it. */
    withIcon?: boolean;
    /** Also fetch a photo for templates that show one. */
    withPhoto?: boolean;
    /** A photo to try before the page's own images. */
    photoUrl?: string;
  } = {}
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
  const pageUrl = response.url || url;
  const { title, description, iconUrls, photoUrls } = parsePageMetadata(html, pageUrl);

  // Try the next candidate when an icon is missing or in an unsupported format.
  const findIcon = async () => {
    if (!withIcon) return;
    for (const iconUrl of iconUrls) {
      if (pageDeadlineAt <= Date.now()) return;
      const icon = await fetchIconDataUrl(
        iconUrl,
        Math.max(1, pageDeadlineAt - Date.now()),
        fetchImpl
      );
      if (icon) return icon;
    }
  };

  const findPhoto = async () => {
    if (!withPhoto) return;
    const photoDeadlineAt = Math.min(deadlineAt, Date.now() + 15_000);
    const explicitUrl = photoUrl && createValidPhotoUrl(pageUrl, photoUrl);
    const candidates = new Set([...(explicitUrl ? [explicitUrl] : []), ...photoUrls]);
    for (const candidate of candidates) {
      if (photoDeadlineAt <= Date.now()) return;
      const photo = await fetchPhotoDataUrl(
        candidate,
        Math.max(1, photoDeadlineAt - Date.now()),
        fetchImpl
      );
      if (photo) return photo;
    }
  };

  const [icon, photo] = await Promise.all([findIcon(), findPhoto()]);
  return { title, description, icon, photo, url: formatDisplayUrl(url) };
};

/**
 * True for this service's own `/og` path. Such an icon or photo would put a
 * card inside a card, and fetching it would render another OG image.
 */
const isFiimageOgPath = (pathname: string) => pathname === "/og" || pathname === "/og/";

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
  if (isFiimageOgPath(pathname)) return;

  return iconUrl.toString();
};

/** Create a valid photo URL, skipping formats and sources that cannot be used. */
const createValidPhotoUrl = (url: string, photo: string) => {
  if (!photo) return;

  let photoUrl: URL;
  try {
    photoUrl = new URL(photo, url);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(photoUrl.protocol)) return;

  const pathname = photoUrl.pathname.toLowerCase();
  if (pathname.endsWith(".ico") || pathname.endsWith(".svg")) return;
  if (isFiimageOgPath(pathname)) return;

  return photoUrl.toString();
};

const DECODABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const hasDecodableImageType = (response: globalThis.Response) => {
  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return DECODABLE_IMAGE_TYPES.includes(contentType);
};

/** Scale an image down so it still covers `box`, keeping its aspect ratio. */
export const getCoverSize = (
  width: number,
  height: number,
  box: { width: number; height: number }
) => {
  const scale = Math.min(1, Math.max(box.width / width, box.height / height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/** Fetch and shrink an optional page photo; a bad photo should not break OG output. */
const fetchPhotoDataUrl = async (
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
) => {
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await fetchSafeResponse(url, {
      headers: {
        Accept: DECODABLE_IMAGE_TYPES.join(","),
        [FIIMAGE_FETCH_HEADER]: "1",
      },
      timeoutMs,
      fetchImpl,
    });
    if (!response.ok || !hasDecodableImageType(response)) {
      await response.body?.cancel();
      return;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_PHOTO_BYTES) {
      await response.body?.cancel();
      return;
    }

    const body = await readResponseBody(response, MAX_PHOTO_BYTES, {
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
    });
    if (body.length === 0) return;

    const image = new Bun.Image(body, {
      autoOrient: true,
      maxPixels: MAX_SOURCE_PIXELS,
    });
    const { width, height } = await withDeadline(
      image.metadata(),
      deadlineAt,
      "Photo metadata timed out."
    );
    if (width < MIN_CONTENT_IMAGE_SIZE || height < MIN_CONTENT_IMAGE_SIZE) return;

    const size = getCoverSize(width, height, PHOTO_SIZE);
    const jpeg = await withDeadline(
      image.resize(size.width, size.height).jpeg({ quality: 80 }).buffer(),
      deadlineAt,
      "Photo resizing timed out."
    );
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return;
  }
};

/** Fetch optional favicon bytes safely; a bad icon should not break OG output. */
const fetchIconDataUrl = async (
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
) => {
  try {
    const response = await fetchSafeResponse(url, {
      headers: {
        Accept: DECODABLE_IMAGE_TYPES.join(","),
        [FIIMAGE_FETCH_HEADER]: "1",
      },
      timeoutMs,
      fetchImpl,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }

    if (!hasDecodableImageType(response)) {
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
  // Drop whitespace-only text between tags, which Satori would draw as spaces.
  const htmlObject = parse(await useTheTemplate(metadata, template), {
    trim: true,
  });
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

  const { host, path } = getAddressParts(metadata.url);
  $("#host").text(host);
  $("#path").text(path);

  if (!metadata.icon) $("#icon").remove();
  else $("#icon").attr("src", metadata.icon);

  // The photo is a background: resvg cuts off an <img> that Satori crops
  // with object-fit when the image is much taller or wider than the card.
  const photo = $("#photo");
  if (!metadata.photo) photo.remove();
  else photo.attr("style", `${photo.attr("style") ?? ""};background-image:url(${metadata.photo})`);

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
