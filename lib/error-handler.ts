import { NextFunction, Request, Response } from "express";
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  UpstreamResponseError,
} from "./errors";

export const handleError = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error(error);

  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof PayloadTooLargeError) {
    res.status(413).json({ error: error.message });
    return;
  }
  // RemoteTimeoutError extends RequestTimeoutError, so fetch/body deadlines
  // use the same gateway-timeout response.
  if (error instanceof RequestTimeoutError) {
    res.status(504).json({ error: error.message });
    return;
  }
  if (error instanceof UpstreamResponseError) {
    res.status(502).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: "Unable to generate the image." });
};
