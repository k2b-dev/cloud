import { createCroppedImageCanvas, type ImageCropState } from "@k2b/ui";
import { MAX_AVATAR_BYTES, MAX_AVATAR_DATA_URL_LENGTH } from "../contracts";

const ACCEPTED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_AVATAR_BYTES = 32 * 1024 * 1024;
const AVATAR_CANVAS_SIZES = [256, 192, 160, 128, 96, 64] as const;
const AVATAR_OUTPUT_ATTEMPTS = [
  { type: "image/webp", qualities: [0.86, 0.76, 0.66, 0.56, 0.46, 0.36] },
  { type: "image/jpeg", qualities: [0.84, 0.74, 0.64, 0.54, 0.44, 0.34] },
  { type: "image/png", qualities: [undefined] },
] as const;

export class AvatarUploadError extends Error {
  constructor(readonly code: "type_invalid" | "too_large" | "empty" | "unsupported" | "compression_failed") {
    super(code);
    this.name = "AvatarUploadError";
  }
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read avatar image."));
    reader.readAsDataURL(blob);
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const fitsAvatarLimits = async (blob: Blob): Promise<string | null> => {
  if (blob.size > MAX_AVATAR_BYTES) return null;
  const dataUrl = await blobToDataUrl(blob);
  return dataUrl.length <= MAX_AVATAR_DATA_URL_LENGTH ? dataUrl : null;
};

const loadImage = async (file: File): Promise<HTMLImageElement> => {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return image;
  } catch {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode avatar image."));
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const validateAvatarSourceFile = (file: File): void => {
  if (!ACCEPTED_AVATAR_TYPES.has(file.type)) {
    throw new AvatarUploadError("type_invalid");
  }
  if (file.size > MAX_SOURCE_AVATAR_BYTES) {
    throw new AvatarUploadError("too_large");
  }
};

export const createAvatarDataUrlFromFile = async (file: File, cropState?: ImageCropState): Promise<string> => {
  validateAvatarSourceFile(file);

  if (cropState) {
    for (const size of AVATAR_CANVAS_SIZES) {
      const canvas = await createCroppedImageCanvas(file, cropState, { width: size, height: size });

      for (const attempt of AVATAR_OUTPUT_ATTEMPTS) {
        for (const quality of attempt.qualities) {
          const blob = await canvasToBlob(canvas, attempt.type, quality);
          if (!blob || blob.type !== attempt.type) continue;
          const dataUrl = await fitsAvatarLimits(blob);
          if (dataUrl) return dataUrl;
        }
      }
    }

    throw new AvatarUploadError("compression_failed");
  }

  const image = await loadImage(file);
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  if (!sourceSize) throw new AvatarUploadError("empty");

  const sourceX = Math.floor((image.naturalWidth - sourceSize) / 2);
  const sourceY = Math.floor((image.naturalHeight - sourceSize) / 2);

  for (const size of AVATAR_CANVAS_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new AvatarUploadError("unsupported");
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);

    for (const attempt of AVATAR_OUTPUT_ATTEMPTS) {
      for (const quality of attempt.qualities) {
        const blob = await canvasToBlob(canvas, attempt.type, quality);
        if (!blob || blob.type !== attempt.type) continue;
        const dataUrl = await fitsAvatarLimits(blob);
        if (dataUrl) return dataUrl;
      }
    }
  }

  throw new AvatarUploadError("compression_failed");
};

export const pickAvatarDataUrl = (): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";

    const settle = (value: string | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleFocus);
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };

    const handleFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) settle(null);
      }, 250);
    };

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        settle(null);
        return;
      }
      try {
        settle(await createAvatarDataUrlFromFile(file));
      } catch (error) {
        settle(null, error);
      }
    };

    window.addEventListener("focus", handleFocus);
    input.click();
  });
