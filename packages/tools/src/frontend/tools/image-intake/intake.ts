import { HEIF_MAX_BYTES, HEIF_MAX_PIXELS, IMAGE_ACCEPT, isHeif } from "./formats";

export type ImageIntakeFailure = { reason: "unsupported" | "too-large" | "decode-failed" };
export class ImageIntakeError extends Error {
  constructor(public readonly reason: ImageIntakeFailure["reason"]) {
    super(reason);
    this.name = "ImageIntakeError";
  }
}
export type ImageIntakeStage = "waiting" | "loading-decoder" | "decoding";
export type IntakeOptions = { signal: AbortSignal; onStage: (stage: ImageIntakeStage) => void };
export type PreparedImage = { source: Blob; width: number; height: number };
export type HeifOptions = IntakeOptions & { maxPixels: number };
export type ImageIntakeDeps = {
  decodeNative: (source: Blob, signal: AbortSignal) => Promise<{ width: number; height: number }>;
  decodeHeif: (file: File, options: HeifOptions) => Promise<Blob>;
  /** @internal Allows browser tests to exercise the allocation guard with a small fixture. */
  heifMaxPixels?: number;
};

// Also bounds cancellation while a lazy import or an injected decoder is pending.
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

let decoder: typeof import("./heif-decoder") | undefined;
export function disposeHeifDecoder() {
  decoder?.disposeHeifDecoder();
}

export const defaultDeps: ImageIntakeDeps = {
  decodeNative: (source, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const image = new Image();
      const url = URL.createObjectURL(source);
      image.decoding = "async";
      const finish = (error?: unknown) => {
        image.onload = null;
        image.onerror = null;
        signal.removeEventListener("abort", abort);
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      const abort = () => {
        finish(signal.reason);
        image.src = "";
      };
      signal.addEventListener("abort", abort, { once: true });
      image.onload = () => finish();
      image.onerror = () => finish(new ImageIntakeError("decode-failed"));
      try {
        image.src = url;
      } catch (error) {
        finish(error);
      }
    }),
  decodeHeif: async (file, options) => {
    options.onStage("loading-decoder");
    const module = await import("./heif-decoder");
    options.signal.throwIfAborted();
    decoder = module;
    return module.decodeHeif(file, options);
  },
};

const acceptedExtensions = IMAGE_ACCEPT.split(",").filter((value) => value.startsWith("."));
const isCoreFormat = (file: File) =>
  /^image\/(jpeg|png|gif|webp|bmp|svg\+xml|avif)$/iu.test(file.type) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/iu.test(file.name);

export async function prepareImage(file: File, options: IntakeOptions, deps = defaultDeps): Promise<PreparedImage> {
  const { signal, onStage } = options;
  signal.throwIfAborted();
  if (
    !file.type.toLowerCase().startsWith("image/") &&
    !acceptedExtensions.some((extension) => file.name.toLowerCase().endsWith(extension))
  ) {
    throw new ImageIntakeError("unsupported");
  }
  const native = async (source: Blob) => {
    const dimensions = await abortable(deps.decodeNative(source, signal), signal);
    if (!(dimensions.width > 0 && dimensions.height > 0)) throw new ImageIntakeError("decode-failed");
    return { source, ...dimensions };
  };
  onStage("decoding");
  try {
    return await native(file);
  } catch {
    signal.throwIfAborted();
  }
  try {
    const head = new Uint8Array(await abortable(file.slice(0, 64).arrayBuffer(), signal));
    if (!isHeif(file, head)) throw new ImageIntakeError(isCoreFormat(file) ? "decode-failed" : "unsupported");
    if (file.size > HEIF_MAX_BYTES) throw new ImageIntakeError("too-large");
    const source = await abortable(deps.decodeHeif(file, { ...options, maxPixels: deps.heifMaxPixels ?? HEIF_MAX_PIXELS }), signal);
    onStage("decoding");
    return await native(source);
  } catch (error) {
    signal.throwIfAborted();
    throw error instanceof ImageIntakeError ? error : new ImageIntakeError("decode-failed");
  }
}
