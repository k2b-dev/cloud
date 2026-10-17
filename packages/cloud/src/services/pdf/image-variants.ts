import sharp from "sharp";
import type { z } from "zod";
import type { ImageRequest, ImageResponse, ImageVariantHeader } from "./image-protocol";

sharp.concurrency(1);
sharp.cache(false);

/** 32 MiP of RGBA is 128 MiB, a quarter of the worker's 512 MiB data limit. */
const MAX_DECODED_PIXELS = 32 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 268402689; // sharp's unchanged default limitInputPixels.

const fit = (width: number, height: number, box: { width: number; height: number }) => {
  const scale = Math.min(1, box.width / width, box.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/** Worker-only: emit each encoding before creating the next; never retain the source after its single decode. */
export async function prepareImageVariants(
  source: Uint8Array | undefined,
  request: z.infer<typeof ImageRequest>,
  write: (index: number, header: z.infer<typeof ImageVariantHeader>, bytes: Uint8Array) => Promise<void>,
): Promise<z.infer<typeof ImageResponse>> {
  try {
    const metadata = await sharp(source)
      .metadata()
      .catch((error: unknown) => {
        // An unidentified byte stream is unreadable; a recognized but missing codec is unsupported.
        if (error instanceof Error && error.message.toLowerCase().includes("unsupported image format"))
          throw new Error("Unidentified image bytes.");
        throw error;
      });
    if (
      !["jpeg", "png", "webp", "gif", "tiff"].includes(metadata.format) &&
      !(metadata.format === "heif" && metadata.compression === "av1")
    ) {
      return { ok: false, code: "unsupported_format" };
    }
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    if (width * height > MAX_SOURCE_PIXELS) return { ok: false, code: "too_large" };
    const rotated = (metadata.orientation ?? 1) >= 5;
    const upright = { width: rotated ? height : width, height: rotated ? width : height };
    const sizes = request.boxes.map((box) => fit(upright.width, upright.height, box));
    const passthrough = request.boxes.map(
      (box) =>
        metadata.format === "jpeg" &&
        (metadata.orientation === undefined || metadata.orientation === 1) &&
        (metadata.space === "srgb" || metadata.space === "b-w") &&
        // `space` describes the pixels, not the profile: a Display P3 or Adobe RGB JPEG also reports srgb.
        !metadata.hasProfile &&
        width <= box.width &&
        height <= box.height &&
        source!.byteLength <= request.maxBytes,
    );
    for (let index = 0; index < sizes.length; index++) {
      if (!passthrough[index]) continue;
      await write(index, { type: "image/jpeg", width, height, bytes: source!.byteLength }, source!);
    }
    const needed = sizes.flatMap((_, index) => (passthrough[index] ? [] : [index]));
    if (!needed.length) return { ok: true };
    const largestIndex = needed.reduce((a, b) => (sizes[a]!.width * sizes[a]!.height >= sizes[b]!.width * sizes[b]!.height ? a : b));
    const largest = sizes[largestIndex]!;
    if (largest.width * largest.height > MAX_DECODED_PIXELS) return { ok: false, code: "too_large" };
    const decoded = await sharp(source)
      .autoOrient()
      // Fit the original box once: fitting already rounded dimensions can shrink an extra pixel.
      .resize({ ...request.boxes[largestIndex]!, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    source = undefined;
    const { data, info } = decoded;
    let transparent = false;
    if (info.channels === 2 || info.channels === 4) {
      for (let offset = info.channels - 1; offset < data.length; offset += info.channels) {
        if (data[offset] !== 255) {
          transparent = true;
          break;
        }
      }
    }
    for (let index = 0; index < sizes.length; index++) {
      if (passthrough[index]) continue;
      const size = sizes[index]!;
      let image = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
      if (size.width !== info.width || size.height !== info.height) image = image.resize(size.width, size.height, { fit: "fill" });
      const type = transparent ? "image/png" : "image/jpeg";
      let encoded: Buffer | undefined = await (transparent
        ? image.png()
        : image.removeAlpha().jpeg({ quality: 85, mozjpeg: true })
      ).toBuffer();
      if (encoded.byteLength <= request.maxBytes) {
        await write(index, { ...size, type, bytes: encoded.byteLength }, encoded);
      }
      encoded = undefined;
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const code = message.includes("pixel limit")
      ? "too_large"
      : message.includes("unsupported image format") || message.includes("compression format has not been built in")
        ? "unsupported_format"
        : "unreadable";
    return { ok: false, code };
  }
}
