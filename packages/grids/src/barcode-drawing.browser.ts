import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal } from "solid-js";
import type * as Drawing from "./barcode-drawing";
import type * as Rendering from "./barcode-rendering";
import { BarcodeRenderError } from "./barcode-values";

let rendering: typeof Rendering | undefined;
let loading = false;
const [ready, setReady] = createSignal(false);

export const barcodesReady: typeof Drawing.barcodesReady = ready;

export const preloadBarcodes: typeof Drawing.preloadBarcodes = () => {
  if (loading) return;
  loading = true;
  void importOnDemand(() => import("./barcode-rendering")).then((module) => {
    // A failed load already offered a reload; the next drawing that needs the code tries again.
    if (!module) {
      loading = false;
      return;
    }
    rendering = module;
    setReady(true);
  });
};

/** Callers check `barcodesReady()` first; before that, a drawing starts the load and fails like an undrawable value. */
const loaded = (): typeof Rendering => {
  if (rendering) return rendering;
  preloadBarcodes();
  throw new BarcodeRenderError("barcode drawing code is still loading");
};

export const barcodeSvgForCell: typeof Drawing.barcodeSvgForCell = (value, format) => loaded().barcodeSvgForCell(value, format);

export const barcodeDataUrl: typeof Drawing.barcodeDataUrl = (value, format, options) => loaded().barcodeDataUrl(value, format, options);
