/**
 * Open Graph
 */

import { load } from "cheerio";
import { Request, Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
// Satori loads fflate from its CJS build at runtime. Load it first so
// Vercel's Bun function trace includes the package before Satori initializes.
import "fflate";
import satori from "satori";
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
      const template = await useTheTemplate(metadata, query.template);
      const htmlObject = parse(template);
      const svg = await withDeadline(
        createSVGFromHTMLObject(htmlObject),
        deadlineAt,
        "Open Graph SVG generation timed out."
      );
      const png = await withDeadline(
        createPNGFromSVG(svg),
        deadlineAt,
        "Open Graph PNG generation timed out."
      );

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

type TMetadata = {
  title: string;
  description?: string;
  url?: string;
  icon?: string;
};

/**
 * Get the page metadata
 * @param url
 * @returns Metadata object
 */
const getPageMetadata = async (
  url: string,
  deadlineAt: number
): Promise<TMetadata> => {
  const pageDeadlineAt = Math.min(deadlineAt, Date.now() + 10_000);
  const response = await fetchSafeResponse(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    timeoutMs: Math.max(1, pageDeadlineAt - Date.now()),
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

  const html = new TextDecoder().decode(body);
  const $ = load(html);

  const iconUrl = createValidIconUrl(
    response.url || url,
    $("link[rel=icon]").attr("href") || ""
  );
  const icon =
    iconUrl && pageDeadlineAt > Date.now()
      ? await fetchIconDataUrl(iconUrl, Math.max(1, pageDeadlineAt - Date.now()))
      : undefined;

  return {
    title: $("title").first().text().slice(0, MAX_TITLE_LENGTH),
    description: $("meta[name=description]")
      .attr("content")
      ?.slice(0, MAX_DESCRIPTION_LENGTH),
    icon,
    url,
  };
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
  if (iconUrl.pathname.toLowerCase().endsWith(".ico")) return;

  return iconUrl.toString();
};

/** Fetch optional favicon bytes safely; a bad icon should not break OG output. */
const fetchIconDataUrl = async (url: string, timeoutMs: number) => {
  try {
    const response = await fetchSafeResponse(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
      timeoutMs,
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
