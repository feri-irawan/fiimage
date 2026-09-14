import { Request, Response } from "express";
import { createOGImage } from "../lib/og";
import { handleError } from "../lib/error-handler";

export default async function handler(req: Request, res: Response) {
  try {
    await createOGImage(req, res);
  } catch (error) {
    handleError(error, req, res, () => undefined);
  }
}
