import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal } from "solid-js";
import type * as Drawing from "./barcode-drawing";
import type * as Rendering from "./barcode-rendering";
import { BarcodeRenderError } from "./barcode-values";

let rendering: typeof Rendering | undefined;
let warming: Promise<boolean> | undefined;
let loading = false;
const [state, setState] = createSignal<"waiting" | "ready" | "failed">("waiting");
const loaded = (module: typeof Rendering) => {
  rendering = module;
  setState("ready");
};

export const barcodesReady: typeof Drawing.barcodesReady = () => state() === "ready";

export const barcodesFailed: typeof Drawing.barcodesFailed = () => state() === "failed";

/** Warms the code once and silently; a drawing that needs the code reports a failure (`loadBarcodes`). */
export const preloadBarcodes: typeof Drawing.preloadBarcodes = () => {
  warming ??= import("./barcode-rendering").then(
    (module) => {
      loaded(module);
      return true;
    },
    () => false,
  );
};

/**
 * Loads the code for a drawing that waits for it, after a running warm-up. A failure offers a reload, as all code
 * loaded on demand does, and the drawings show their values as text.
 */
export const loadBarcodes: typeof Drawing.loadBarcodes = () => {
  if (rendering || loading || state() === "failed") return;
  loading = true;
  void (warming ?? Promise.resolve(false)).then(async (warmed) => {
    if (warmed) return;
    const module = await importOnDemand(() => import("./barcode-rendering"));
    if (module) loaded(module);
    else setState("failed");
  });
};

/** Callers check `barcodesReady()` first; before that, a drawing starts the load and fails like an undrawable value. */
const drawing = (): typeof Rendering => {
  if (rendering) return rendering;
  loadBarcodes();
  throw new BarcodeRenderError("barcode drawing code is not loaded");
};

export const barcodeSvgForCell: typeof Drawing.barcodeSvgForCell = (value, format) => drawing().barcodeSvgForCell(value, format);

export const barcodeDataUrl: typeof Drawing.barcodeDataUrl = (value, format, options) => drawing().barcodeDataUrl(value, format, options);
