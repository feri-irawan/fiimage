import express from "express";
import { generateThumbnail } from "./lib/thumbnail";

const server = express();

// Generate thumbnail
server.get("/", generateThumbnail);

// Web capture
// server.get("/capture");

if (process.env.NODE_ENV === "development") server.listen(3000);

export default server;
