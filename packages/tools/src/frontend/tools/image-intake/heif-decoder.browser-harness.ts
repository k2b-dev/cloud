import { defaultDeps, disposeHeifDecoder, ImageIntakeError, prepareImage } from "./intake";

declare global {
  interface Window {
    runIntake: (
      name: string,
      type: string,
      bytes: number[],
      maxPixels?: number,
    ) => Promise<{
      status: string;
      width?: number;
      height?: number;
      type?: string;
      workers: number;
      mainThreadDecoder: boolean;
    }>;
  }
}
let workers = 0;
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(...args: ConstructorParameters<typeof Worker>) {
    super(...args);
    workers += 1;
  }
};
window.runIntake = async (name, type, bytes, maxPixels) => {
  const file = new File([new Uint8Array(bytes)], name, { type });
  const deps =
    maxPixels === undefined
      ? defaultDeps
      : {
          ...defaultDeps,
          heifMaxPixels: maxPixels,
          decodeNative: (source: Blob, signal: AbortSignal) => {
            // Exercise the worker allocation guard even when Safari can decode HEIC natively.
            if (source === file) return Promise.reject(new Error("Exercise HEIF fallback"));
            return defaultDeps.decodeNative(source, signal);
          },
        };
  try {
    const image = await prepareImage(file, { signal: new AbortController().signal, onStage: () => {} }, deps);
    return {
      status: "ready",
      width: image.width,
      height: image.height,
      type: image.source.type,
      workers,
      mainThreadDecoder: "libheif" in globalThis,
    };
  } catch (error) {
    return { status: error instanceof ImageIntakeError ? error.reason : "unexpected", workers, mainThreadDecoder: "libheif" in globalThis };
  } finally {
    disposeHeifDecoder();
  }
};
