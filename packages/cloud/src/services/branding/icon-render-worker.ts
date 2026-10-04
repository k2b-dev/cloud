// Standalone subprocess. No server imports or application credentials.

import { createCanvas, type Image, loadImage } from "@napi-rs/canvas";
import { z } from "zod";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const inputSchema = z.object({
  source: z.string().max(Math.ceil((MAX_SOURCE_BYTES * 4) / 3)),
  mime: z.string().max(100),
  fallback: z.string().max(64 * 1024),
  variants: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        size: z.number().int().min(16).max(1024),
        /** Opaque background, or none for a transparent icon. */
        background: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .nullable(),
        /** Side of the centred square the logo fits into, as a fraction of the icon. */
        box: z.number().gt(0).max(1),
      }),
    )
    .min(1)
    .max(8),
});

/** Gives an SVG root the target size, so the vector renders sharp instead of being scaled as a bitmap. */
const sizedSvg = (svg: string, size: number): string =>
  svg.replace(/<svg\b([^>]*)>/i, (_tag, attributes: string) => {
    const width = /\swidth\s*=\s*["']?([\d.]+)/i.exec(attributes)?.[1];
    const height = /\sheight\s*=\s*["']?([\d.]+)/i.exec(attributes)?.[1];
    let rest = attributes.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    // Without a viewBox, a new size would crop instead of scale.
    if (!/\sviewBox\s*=/i.test(rest) && width && height) rest += ` viewBox="0 0 ${width} ${height}"`;
    return `<svg${rest} width="${size}" height="${size}">`;
  });

const decode = async (data: Buffer, mime: string, size: number): Promise<Image> =>
  loadImage(mime === "image/svg+xml" ? Buffer.from(sizedSvg(data.toString("utf8"), size)) : data);

try {
  const input = inputSchema.parse(JSON.parse(await Bun.stdin.text()));
  const source = Buffer.from(input.source, "base64");
  if (source.byteLength > MAX_SOURCE_BYTES) throw new Error("The logo exceeds the 10 MiB limit.");
  let fallback = false;
  const icons: Record<string, string> = {};
  for (const variant of input.variants) {
    const box = Math.round(variant.size * variant.box);
    let image: Image;
    try {
      if (fallback) throw new Error("fallback");
      image = await decode(source, input.mime, box);
      if (!(image.width > 0 && image.height > 0)) throw new Error("empty");
    } catch {
      fallback = true;
      image = await decode(Buffer.from(input.fallback), "image/svg+xml", box);
    }
    const canvas = createCanvas(variant.size, variant.size);
    const context = canvas.getContext("2d");
    if (variant.background) {
      context.fillStyle = variant.background;
      context.fillRect(0, 0, variant.size, variant.size);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // Fit the logo into the centred box and keep its aspect ratio.
    const scale = Math.min(box / image.width, box / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (variant.size - width) / 2, (variant.size - height) / 2, width, height);
    icons[variant.id] = Buffer.from(canvas.toBuffer("image/png")).toString("base64");
  }
  process.stdout.write(JSON.stringify({ icons, fallback }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof z.ZodError ? "Invalid icon request." : "Icon rendering failed." }));
  process.exitCode = 1;
}
