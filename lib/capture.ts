/**
 * Capture the Web Page
 */

import Chromium from "@sparticuz/chromium";
import { Request, Response } from "express";
import puppeteer from "puppeteer-core";
import { z } from "zod";

const querySchema = z.object({
  /** Image URL */
  url: z
    .string({ required_error: "`url` required." })
    .url({ message: "`url` invalid." }),

  /** Image size */
  s: z
    .string()
    .default("640x480")
    .refine((size) => size.includes("x"), { message: "`size` invalid." })
    .transform((v) => ({
      width: Number(v.split("x")[0]),
      height: Number(v.split("x")[1]),
    })),
});

/**
 * Route handler for `/capture`
 */
export const capture = async (req: Request, res: Response) => {
  try {
    // Get the query string
    const { url, s } = querySchema.parse(req.query);

    // Generate the image
    const image = await captureTheWeb({ url, s });

    // Send the response
    res.setHeader("Content-Type", "image/png").send(image);
  } catch (error) {
    console.log(error);

    if (error instanceof z.ZodError) {
      res.status(500).send(JSON.parse(error.message));
      return;
    }

    throw error;
  }
};

/** Capture the web page using Puppeteer */
const captureTheWeb = async ({ url, s }: z.infer<typeof querySchema>) => {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox"],
    executablePath: await Chromium.executablePath(),
  });

  const page = await browser.newPage();
  await page.setViewport({
    width: s.width,
    height: s.height,
    deviceScaleFactor: 1,
  });
  await page.goto(url);

  return await page.screenshot({ type: "png" });
};
