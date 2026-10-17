import sharp from "sharp";
import type { z } from "zod";
import type { ImageRequest, ImageResponse, ImageVariantHeader } from "./image-protocol";

sharp.concurrency(1);
sharp.cache(false);

/**
 * 16 MiP is 64 MiB RGBA; A4 at 300 dpi needs about 5.8 MP. With 270..296 MiB for Bun and 32 MiB for input,
 * about 120..146 MiB of the 512 MiB limit remains for codecs and temporary buffers. Some source decodes need more.
 */
const MAX_DECODED_PIXELS = 16 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 268402689; // sharp's unchanged default limitInputPixels.
// Measured RGBA WebP peaks are non-monotonic: 440..473 MiB at 16 MiP, 476..495 at 24 MiP, 429..457 at 32 MiP.
// Cap full-image decoders at 16 MiP to leave about 40 MiB below the worker's 512 MiB data limit.
const MAX_FULL_DECODE_SOURCE_PIXELS = 16 * 1024 * 1024;

const fit = (width: number, height: number, box: { width: number; height: number }) => {
  const scale = Math.min(1, box.width / width, box.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/** Worker-only: validate pass-throughs, decode once for resized variants, then emit encodings sequentially. */
export async function prepareImageVariants(
  source: Uint8Array | undefined,
  request: z.infer<typeof ImageRequest>,
  write: (index: number, header: z.infer<typeof ImageVariantHeader>, bytes: Uint8Array) => Promise<void>,
): Promise<z.infer<typeof ImageResponse>> {
  let identified = false;
  try {
    const metadata = await sharp(source).metadata();
    identified = true;
    if (
      !["jpeg", "png", "webp", "gif", "tiff"].includes(metadata.format) &&
      !(metadata.format === "heif" && metadata.compression === "av1")
    ) {
      return { ok: false, code: "unsupported_format" };
    }
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    if (width * height > MAX_SOURCE_PIXELS) return { ok: false, code: "too_large" };
    if (["webp", "gif", "tiff", "heif"].includes(metadata.format) && width * height > MAX_FULL_DECODE_SOURCE_PIXELS) {
      return { ok: false, code: "too_large" };
    }
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
    // Metadata alone accepts truncated JPEGs. Validate once with default failOn before emitting any unchanged bytes.
    if (passthrough.some(Boolean)) await sharp(source).resize(8, 8, { fit: "inside" }).toBuffer();
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
      // Fit the original box once: fitting already rounded dimensions can shrink an extra pixel.
      .resize({ ...request.boxes[largestIndex]!, fit: "inside", withoutEnlargement: true })
      // autoOrient before resize disables shrink-on-load.
      .autoOrient()
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
    // Codec allocation errors can also mention a corrupt header or unsupported format. Memory takes precedence.
    // Unidentified byte streams are unreadable; a recognized but missing codec is unsupported.
    const code = ["out of memory", "insufficient memory", "memory allocation", "cannot allocate", "pixel limit"].some((part) =>
      message.includes(part),
    )
      ? "too_large"
      : (identified && message.includes("unsupported image format")) || message.includes("compression format has not been built in")
        ? "unsupported_format"
        : "unreadable";
    return { ok: false, code };
  }
}
