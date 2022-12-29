import { log } from "console";
import { createCanvas, registerFont } from "canvas";
import { resolve } from "path";
import wordwrap from "wordwrapjs";

const fontsDir = resolve("fonts");

export default async function createImage(req, res) {
  let { text, width, color, outline, outlineWidth, padding, fontSize } =
    req.query;

  fontSize = fontSize ? Number(fontSize) : 50;
  padding = padding ?? 16;
  color = color ?? "#FFFFFF";
  outline = outline ?? "#000000";
  outlineWidth = 8;
  width = width ?? 280 + (fontSize > 50 ? fontSize * 2 + padding * 2 : 0);
  text = wordwrap.lines(text, { width: 10 + fontSize / width, break: true });

  const canvas = createCanvas(
    width,
    (fontSize + 5) * text.length + padding * 2 + outlineWidth * 2
  );
  const ctx = canvas.getContext("2d");

  // Text
  registerFont(fontsDir + "/bangers.ttf", {
    family: "customFont",
  });
  ctx.font = `bold ${fontSize}px customFont`;
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.strokeStyle = outline;
  ctx.lineWidth = outlineWidth;

  let i = 1;
  for (const words of text) {
    const x = width / 2 - padding / 4;
    const y = (fontSize + 5) * i + padding / 2 + outlineWidth;

    ctx.strokeText(words, x, y);
    ctx.fillText(words, x, y);
    i++;
  }

  // Membuat respon gambar
  const buffer = canvas.toBuffer();
  res.setHeader("Content-Type", "image/png");
  res.send(buffer);
}
