import express from "express";
import { generateThumbnail } from "./lib/thumbnail";
import { capture } from "./lib/capture";
import { createOGImage } from "./lib/og";

const server = express();

// Generate thumbnail
server.get("/", generateThumbnail);

// Web capture
server.get("/capture", capture);

// Open Graph
server.get("/og", createOGImage);

if (process.env.NODE_ENV === "development") server.listen(3000);

export default server;
