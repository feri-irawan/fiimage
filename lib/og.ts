/**
 * Open Graph
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { Request, Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import satori from "satori";
import sharp from "sharp";
import parse from "html-react-parser";
import { z } from "zod";

/**
 * Route handler `/og`
 * @param req
 * @param res
 */
export const createOGImage = async (req: Request, res: Response) => {
  try {
    const query = querySchema.parse(req.query);
    const metadata = await getPageMetadata(query.url);
    const template = useTheTemplate(metadata, query.template);
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
const querySchema = z.object({
  url: z.string().url(),
  template: z.enum(["default"]).default("default"),
});

type TMetadata = {
  title: string;
  description: string;
  url: string;
};

/**
 * Get the page metadata
 * @param url
 * @returns Metadata object
 */
const getPageMetadata = async (url: string): Promise<TMetadata> => {
  const html = await axios.get(url).then(({ data }) => data);
  const $ = cheerio.load(html);

  return {
    title: $("title").text(),
    description: $("meta[name=description]").attr("content") || "",
    url,
  };
};

/**
 * Use Template
 * @param metadata
 * @param template
 * @returns HTML string
 */
const useTheTemplate = (
  metadata: TMetadata,
  template: "default" = "default"
) => {
  // Load the template
  const $ = cheerio.load(
    readFileSync(resolve(`templates/og/${template}.html`)),
    null,
    false
  );

  $("style").remove();

  // Populate meta data to HTML
  $("#title").text(metadata.title);
  $("#description").text(metadata.description);
  $("#url").text(metadata.url);

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
      {
        name: "Bangers",
        data: readFileSync(resolve("fonts/bangers.ttf")),
        weight: 400,
        style: "normal",
      },
    ],
  });
};

const createPNGFromSVG = async (svg: string) => {
  return await sharp(Buffer.from(svg)).png().toBuffer();
};
