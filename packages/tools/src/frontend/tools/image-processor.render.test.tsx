import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImgData } from "@k2b/stdlib/browser";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { DEFAULT_ADJ } from "./image-processor/constants";
import type { ImageEntry } from "./image-processor/types";

const root = mkdtempSync(join(tmpdir(), "tools-image-processor-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ImageProcessor, ImageProcessorView } = await import("./ImageProcessor.island.tsx");

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

const renderView = (props: Parameters<typeof ImageProcessorView>[0] = {}) =>
  renderToString(() => createComponent(ImageProcessorView, props));
/** The part of the page from the inspector (its edit and markup tabs) to its end. */
const inspector = (html: string) => html.slice(html.indexOf('aria-label="Image controls"'));

describe("Photo editor on v2", () => {
  test("an empty editor is one column that offers to add photos and says they stay in the browser", () => {
    const html = renderToString(() => createComponent(ImageProcessor, {}));

    expect(html).toContain('data-k2-part="Workspace"');
    expect(html).toContain("Add images");
    expect(html).toContain("never uploaded");
    // no inspector and no export while nothing is open: no half of the page waits empty
    expect(html).not.toContain('aria-label="Image controls"');
    expect(html).not.toContain(">Export<");
  });

  test("an open photo shows its name and size above the stage, the edit tab and the export in the head", () => {
    const html = renderView({ initialImages: [image] });

    // one head row: the photo is the last step of the path, its size a fact in the inspector
    expect(html).not.toContain('data-k2-part="StatusRow"');
    expect(html.slice(html.indexOf('data-k2-part="Path"'))).toContain("invoice.png");
    expect(html).toContain("invoice.png");
    expect(inspector(html)).toMatch(/1200 × 800 px/);
    expect(html).toContain('<img src="data:image/png;base64,aW1hZ2U=" alt="Preview"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Fit image"');
    expect(html).toContain('aria-label="More image actions"');
    expect(html).toContain(">Export<");
    const controls = inspector(html);
    expect(controls).toMatch(/data-k2-part="Tabs" aria-label="Editor mode"/);
    expect(controls).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Edit</);
    for (const title of ["Photo", "Transform", "Adjustments", "Presets", "Edits"]) expect(controls).toContain(`<h3>${title}</h3>`);
    // the crop button names its group; no heading says the same word above it
    expect(controls).not.toContain("<h3>Crop</h3>");
    expect(controls).toMatch(/<span class="k2-btn-label">Crop<\/span>/);
    expect(controls).toContain('role="switch"');
    // the presets show themselves on the photo; the one that matches the look is pressed
    expect(controls.match(/aria-pressed="true"/g)).toHaveLength(1);
    // one image: the strip holds it and the way to more; no paste to all
    expect(html).toContain('aria-label="Images"');
    expect(html).toMatch(/aria-label="Add images" title="Add images"/);
    expect(controls).not.toContain("Paste adjustments to all images");
  });

  test("several photos show a strip under the stage and where the open one stands", () => {
    const second: ImageEntry = { ...image, id: "image-2", name: "receipt.png" };
    const html = renderView({ initialImages: [image, second] });

    expect(html).toContain('aria-label="Images"');
    expect(html).toContain('aria-label="Open invoice.png"');
    expect(html).toContain('aria-label="Open receipt.png"');
    expect(html).toMatch(/aria-label="Open invoice.png" aria-current="true"|aria-current="true"[^>]*aria-label="Open invoice.png"/);
    expect(html).toContain("image 1 of 2");
  });

  test("the markup tab offers its tools, and its history deeds start disabled", () => {
    const html = inspector(renderView({ initialImages: [image], initialEditorMode: "markup" }));

    expect(html).toContain("<h3>Tool</h3>");
    expect(html).toContain("<h3>Style</h3>");
    expect(html).toContain('aria-label="Pen"');
    expect(html).toMatch(/aria-label="Pen"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Pen"/);
    for (const deed of ["Undo markup", "Redo markup", "Delete selected markup", "Clear markup"])
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${deed}"[^>]*disabled|<button[^>]*disabled[^>]*aria-label="${deed}"`));
    expect(html).not.toContain("<h3>Crop</h3>");
  });

  test("while cropping, adding, removing and export wait, and the crop can be applied or cancelled", () => {
    const html = renderView({ initialImages: [image], initialCropActive: true });

    expect(html).toContain("Apply");
    expect(html).toContain("Cancel");
    expect(html).toContain("Drag the frame or its corners");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Add images/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*>Export</);
    expect(html).toContain("data-crop-handle");
  });

  test("files that could not be added say why and how to go on, each on its own", () => {
    const html = renderView({
      initialLoadFailures: [
        { file: new File([], "broken.heic", { type: "image/heic" }), reason: "decode-failed" },
        { file: new File([], "scan.tiff", { type: "image/tiff" }), reason: "unsupported" },
        { file: new File([], "later.png", { type: "image/png" }), reason: "crop-active" },
      ],
    });

    expect(html.match(/data-k2-part="Notice"/g)).toHaveLength(3);
    expect(html).toContain("broken.heic: This image could not be read.");
    expect(html).toContain("Export it again from the source app, or choose another file.");
    expect(html).toContain("scan.tiff: This format is not supported.");
    expect(html).toContain("later.png: Apply or cancel the crop before adding images");
    expect(html).toContain("Apply or cancel it, then add the images again.");
    expect(html).toContain("Hide broken.heic");
  });
});
