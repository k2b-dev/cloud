import { editorOutputSize, IMAGE_EDITOR_PREVIEW_LONG_EDGE } from "./model";
import { renderImageEditor } from "./render";
import type { ImageEditorFormat, ImageEditorProps, ImageEditorResult, ImageEditorSourceSize, ImageEditorState } from "./types";

const isFormat = (type: string): type is ImageEditorFormat => type === "image/jpeg" || type === "image/png" || type === "image/webp";
const validSize = (size: ImageEditorSourceSize) =>
  Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0;
const releaseCanvas = (canvas: HTMLCanvasElement) => {
  canvas.width = canvas.height = 0;
};

/** A failed allocation/encode never silently saves a smaller image. The caller offers an explicit retry. */
export class ImageEditorSizeError extends Error {
  readonly suggestedMegapixels: number;
  constructor(width: number, height: number) {
    super("This browser could not produce the requested image size");
    this.name = "ImageEditorSizeError";
    this.suggestedMegapixels = Math.min(16.7, (width * height) / 2_000_000);
  }
}

const sourceBlob = async (source: Blob | string, signal: AbortSignal): Promise<Blob> => {
  signal.throwIfAborted();
  if (typeof source !== "string") return source;
  const response = await fetch(source, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("The image could not be loaded");
  return response.blob();
};

async function decode(source: Blob | string, signal: AbortSignal) {
  const blob = await sourceBlob(source, signal);
  signal.throwIfAborted();
  const image = new Image();
  image.decoding = "async";
  const url = URL.createObjectURL(blob);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    image.onload = image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        image.onload = image.onerror = null;
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      image.onload = () => finish();
      image.onerror = () => finish(new Error("This image could not be decoded"));
      image.src = url;
    });
    signal.throwIfAborted();
    const size = { width: image.naturalWidth, height: image.naturalHeight, type: blob.type };
    if (!validSize(size)) throw new Error("Invalid image dimensions");
    return { image, size, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Retains only a bounded canvas. With caller previews, the original is neither fetched nor decoded here. */
export async function loadImageEditorPreview(props: ImageEditorProps, signal: AbortSignal) {
  signal.throwIfAborted();
  if (props.sourceSize && !validSize(props.sourceSize)) throw new Error("Invalid image dimensions");
  if (props.previews?.length && !props.sourceSize) throw new Error("Caller image previews require original dimensions");
  if (props.previews?.some((preview) => !validSize(preview))) throw new Error("Invalid image preview dimensions");
  const candidates = props.previews?.toSorted((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  const preview = candidates?.find((item) => Math.max(item.width, item.height) >= IMAGE_EDITOR_PREVIEW_LONG_EDGE) ?? candidates?.at(-1);
  const decoded = await decode(preview?.source ?? props.source, signal);
  const canvas = document.createElement("canvas");
  try {
    const sourceSize = props.sourceSize ?? decoded.size;
    // A caller preview must depict the same complete image, allowing one pixel of rounding at its smaller edge.
    const ratio = sourceSize.width / sourceSize.height;
    if (preview && Math.abs(decoded.size.width - ratio * decoded.size.height) > Math.max(1, ratio))
      throw new Error("The preview dimensions do not match the original image");
    const scale = Math.min(1, IMAGE_EDITOR_PREVIEW_LONG_EDGE / Math.max(decoded.size.width, decoded.size.height));
    canvas.width = Math.max(1, Math.round(decoded.size.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.size.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw an image preview");
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    signal.throwIfAborted();
    return {
      image: canvas,
      sourceSize,
      width: canvas.width,
      height: canvas.height,
      dispose: () => releaseCanvas(canvas),
    };
  } catch (error) {
    releaseCanvas(canvas);
    throw error;
  } finally {
    decoded.dispose();
  }
}

const encode = (canvas: HTMLCanvasElement, format: ImageEditorFormat, quality?: number, signal?: AbortSignal): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      canvas.toBlob(
        (blob) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) return abort();
          if (!blob?.size) reject(new ImageEditorSizeError(canvas.width, canvas.height));
          else if (blob.type !== format) reject(new Error("This browser cannot encode the selected image format"));
          else resolve(blob);
        },
        format,
        quality,
      );
    } catch {
      signal?.removeEventListener("abort", abort);
      reject(new ImageEditorSizeError(canvas.width, canvas.height));
    }
  });

let formats: Promise<ImageEditorFormat[]> | undefined;
/** Probe the actual encoder once per page; Safari may return PNG for an unsupported requested type. */
export function supportedImageEditorFormats(): Promise<ImageEditorFormat[]> {
  formats ??= (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    try {
      const supported: ImageEditorFormat[] = [];
      for (const format of ["image/jpeg", "image/png", "image/webp"] as const) {
        try {
          await encode(canvas, format);
          supported.push(format);
        } catch {
          // A refused type is omitted; the original format is never mislabelled.
        }
      }
      return supported;
    } finally {
      releaseCanvas(canvas);
    }
  })();
  return formats;
}

// Only an input type without a supported encoder needs alpha detection. Read small strips, yielding between
// strips so cancellation works; never allocate a second full-size ImageData for a large original.
async function hasTransparency(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<boolean> {
  const context = canvas.getContext("2d");
  if (!context) throw new ImageEditorSizeError(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 64) {
    signal.throwIfAborted();
    const pixels = context.getImageData(0, y, canvas.width, Math.min(64, canvas.height - y)).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

/** Export loads the original once, uses the exact preview renderer, and releases its full-size allocations. */
export async function exportImageEditor(
  props: ImageEditorProps,
  state: ImageEditorState,
  output = props.output,
  signal = new AbortController().signal,
): Promise<ImageEditorResult> {
  signal.throwIfAborted();
  const decoded = await decode(props.source, signal);
  const canvas = document.createElement("canvas");
  const scratch = document.createElement("canvas");
  try {
    if (props.sourceSize && (props.sourceSize.width !== decoded.size.width || props.sourceSize.height !== decoded.size.height))
      throw new Error("The original image dimensions have changed");
    const size = editorOutputSize(decoded.size, state, props.maxOutputMegapixels, output?.maxLongEdge);
    try {
      canvas.width = size.width;
      canvas.height = size.height;
      renderImageEditor(decoded.image, decoded.size, state, canvas, scratch);
    } catch {
      throw new ImageEditorSizeError(size.width, size.height);
    }
    signal.throwIfAborted();
    // Scratch is only needed while drawing, not while checking alpha or encoding.
    releaseCanvas(scratch);
    const supported = await supportedImageEditorFormats();
    signal.throwIfAborted();
    const requested = output?.format ?? "same";
    const sourceType = decoded.size.type;
    const format: ImageEditorFormat =
      requested !== "same"
        ? requested
        : isFormat(sourceType) && supported.includes(sourceType)
          ? sourceType
          : (await hasTransparency(canvas, signal))
            ? "image/png"
            : "image/jpeg";
    if (!supported.includes(format)) throw new Error("This browser cannot encode the selected image format");
    if (format === "image/jpeg") {
      const context = canvas.getContext("2d");
      if (!context) throw new ImageEditorSizeError(size.width, size.height);
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
    }
    const blob = await encode(canvas, format, output?.quality ?? 0.9, signal);
    return { blob, ...size, type: format, originalWidth: decoded.size.width, originalHeight: decoded.size.height };
  } finally {
    decoded.dispose();
    releaseCanvas(canvas);
    releaseCanvas(scratch);
  }
}
