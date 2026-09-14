import { Request, Response } from "express";
import { generateThumbnail } from "../lib/thumbnail";
import { handleError } from "../lib/error-handler";

export default async function handler(req: Request, res: Response) {
  try {
    await generateThumbnail(req, res);
  } catch (error) {
    handleError(error, req, res, () => undefined);
  }
}
