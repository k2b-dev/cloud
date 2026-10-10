import { describe, expect, test } from "bun:test";
import type { ImgData } from "@k2b/stdlib/browser";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_ADJ } from "./image-processor/constants";
import type { ImageEntry } from "./image-processor/types";

const imageData = { width: 1200, height: 800 } as ImgData;
const image: ImageEntry = {
  id: "image-1",
  file: new File(["image"], "invoice.png", { type: "image/png" }),
  source: imageData,
  previewSource: imageData,
  originalSource: imageData,
  originalPreviewSource: imageData,
  thumbUrl: "data:image/png;base64,aW1hZ2U=",
  name: "invoice.png",
  adj: { ...DEFAULT_ADJ },
  markup: [],
  markupUndo: [],
  markupRedo: [],
  cropped: false,
  cropBounds: { x: 0, y: 0, w: 1, h: 1 },
};

describe("Image Processor crop drag", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a crop drag holds page text selection until its pointer is released", async () => {
    const dom = createDomTestHarness();
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image], initialCropActive: true }), dom.root);
    try {
      // The mount builds the preview; let it settle while the document still exists.
      while (dom.root.querySelector(".ti-loader-2")) await new Promise((resolve) => setTimeout(resolve, 0));
      const handle = dom.root.querySelector<HTMLElement>(".cursor-nwse-resize");
      if (!handle) throw new Error(dom.root.innerHTML);
      const userSelect = () => document.documentElement.style.getPropertyValue("user-select");
      const win = dom.window as unknown as { PointerEvent: typeof PointerEvent };
      const pointer = (type: string, init: PointerEventInit = {}) =>
        handle.dispatchEvent(
          new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: "mouse", isPrimary: true, ...init }),
        );

      pointer("pointerdown", { button: 2, buttons: 2 });
      expect(userSelect()).toBe("");
      pointer("pointerup", { button: 2 });

      pointer("pointerdown", { button: 0, buttons: 1 });
      expect(userSelect()).toBe("none");
      pointer("pointerup", { button: 0 });
      expect(userSelect()).toBe("");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
