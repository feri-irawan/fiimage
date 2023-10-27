/**
 * Open Graph
 */

import axios from "axios";
import cheerio from "cheerio";
import { Request, Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import satori from "satori";
import parse from "html-react-parser";
import { z } from "zod";
import inlineCss from "inline-css";
import { Resvg } from "@resvg/resvg-js";

/**
 * Route handler `/og`
 * @param req
 * @param res
 */
export const createOGImage = async (req: Request, res: Response) => {
  try {
    const query = querySchema.parse(req.query);
    const metadata = await getPageMetadata(query.url);
    const template = await useTheTemplate(metadata, query.template);
    const htmlObject = parse(template);
    const svg = await createSVGFromHTMLObject(htmlObject);
    const png = await createPNGFromSVG(svg);

    res.setHeader("Content-Type", "image/png").send(png);
  } catch (error) {
    console.log(error);

    if (error instanceof z.ZodError) {
      res.status(500).send(JSON.parse(error.message));
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
  url: z.string().url(),
  template: templateSchema,
});

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
const getPageMetadata = async (url: string): Promise<TMetadata> => {
  const html = await axios.get(url).then(({ data }) => data);
  const $ = cheerio.load(html);

  const icon = createValidIconUrl(url, $("link[rel=icon]").attr("href") || "");

  return {
    title: $("title").first().text(),
    description: $("meta[name=description]").attr("content"),
    icon,
    url,
  };
};

/** Create a valid icon URL */
const createValidIconUrl = (url: string, icon: string) => {
  if (!icon) return;

  const host = new URL(url);

  const baseUrl = `${host.protocol}//${host.hostname}`;
  const isRealtiveIconUrl = icon?.startsWith("/");
  const iconWithBaseUrl = isRealtiveIconUrl ? `${baseUrl}${icon}` : icon;
  const isIcoFile = icon?.endsWith(".ico");

  return isIcoFile
    ? `https://fiimage.vercel.app?url=${iconWithBaseUrl}`
    : iconWithBaseUrl;
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
  // Valid HTML
  const html = await inlineCss(
    readFileSync(resolve(`templates/og/${template}.html`), "utf-8"),
    { url: "/" }
  );

  // Load the template
  // @ts-ignore
  const $ = cheerio.load(html, null, false);

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
    fonts: [
      {
        name: "Inter",
        data: readFileSync(resolve("fonts/inter-regular.otf")),
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: readFileSync(resolve("fonts/inter-bold.otf")),
        weight: 700,
        style: "normal",
      },
    ],
  });
};

const createPNGFromSVG = async (svg: string) => {
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
    .render()
    .asPng();
};
