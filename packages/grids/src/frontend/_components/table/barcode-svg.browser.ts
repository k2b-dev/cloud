import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal } from "solid-js";
import type * as Rendering from "../../../barcode-rendering";
import { barcodeKey, barcodeSvgForDisplay, barcodeValueText } from "./BarcodeRendering";
import type * as ServerVariant from "./barcode-svg";

let rendering: typeof Rendering | undefined;
let loading = false;
const [loaded, setLoaded] = createSignal(false);

/**
 * Drawings from the server markup, read while the island modules evaluate: the island's mount removes its server
 * children right after, and the first browser render shows the same SVGs from here until the drawing code is there.
 */
const serverDrawings = new Map<string, string>();
if (typeof document !== "undefined") {
  for (const element of document.querySelectorAll<HTMLElement>("[data-grids-barcode]")) {
    const key = element.dataset.gridsBarcode;
    if (key && element.firstElementChild) serverDrawings.set(key, element.innerHTML);
  }
}

export const preloadBarcodes: typeof ServerVariant.preloadBarcodes = () => {
  if (loading) return;
  loading = true;
  void importOnDemand(() => import("../../../barcode-rendering")).then((module) => {
    // A failed load already offered a reload; the next drawing that needs the code tries again.
    if (!module) {
      loading = false;
      return;
    }
    rendering = module;
    serverDrawings.clear();
    setLoaded(true);
  });
};

export const barcodeMarkup: typeof ServerVariant.barcodeMarkup = (value, format, size) => {
  if (!loaded() || !rendering) {
    const drawing = serverDrawings.get(barcodeKey(barcodeValueText(value).trim(), format, size));
    if (drawing) return drawing;
    preloadBarcodes();
    return undefined;
  }
  const svg = rendering.barcodeSvgForCell(value, format);
  return svg ? barcodeSvgForDisplay(svg, format, size) : null;
};
