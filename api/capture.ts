import { Request, Response } from "express";
import { capture } from "../lib/capture";
import { handleError } from "../lib/error-handler";

export default async function handler(req: Request, res: Response) {
  try {
    await capture(req, res);
  } catch (error) {
    handleError(error, req, res, () => undefined);
  }
}
