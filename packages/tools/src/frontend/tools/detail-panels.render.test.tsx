import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { ImgData } from "@k2b/stdlib/browser";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { DEFAULT_ADJ } from "./image-processor/constants";
import type { ImageEntry } from "./image-processor/types";

const root = mkdtempSync(join(tmpdir(), "tools-detail-panel-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ImageProcessor, ImageProcessorView } = await import("./ImageProcessor.island.tsx");
const { RequestDetail } = await import("./WebhookTester.island.tsx");

const legacyDetailClasses = ['class="detail-header', 'class="detail-stack', 'class="detail-section'];

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

const renderImageProcessor = () => renderToString(() => createComponent(ImageProcessor, {}));
const renderImageProcessorView = (props: Parameters<typeof ImageProcessorView>[0] = {}) =>
  renderToString(() => createComponent(ImageProcessorView, props));

describe("Tools detail panels", () => {
  test("groups webhook request and response data under one shared scroll owner", () => {
    const log: Parameters<typeof RequestDetail>[0]["log"] = {
      id: "request-1",
      endpointId: "endpoint-1",
      direction: "incoming",
      method: "POST",
      url: "https://cloud.example.test/hooks/endpoint-1",
      path: "/hooks/endpoint-1",
      query: "attempt=1",
      requestHeaders: { "content-type": "application/json" },
      requestBody: '{"hello":"world"}',
      requestContentType: "application/json",
      responseStatus: 202,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"accepted":true}',
      durationMs: 18,
      error: null,
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    const endpoint: NonNullable<Parameters<typeof RequestDetail>[0]["endpoint"]> = {
      id: "endpoint-1",
      token: "token",
      name: "Stripe test",
      urlPath: "/hooks/endpoint-1",
      requestCount: 1,
      lastRequestAt: log.createdAt,
      createdAt: log.createdAt,
    };

    const html = renderToString(() => createComponent(RequestDetail, { log, endpoint, onClose: () => undefined }));

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Stripe test</h2>");
    expect(html).toContain('data-scroll-preserve="webhook-request-detail-request-1"');
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('aria-label="Request data"');
    expect(html).toContain('aria-label="Response data"');
    expect(html).toContain("Request headers");
    expect(html).toContain("Response body");
    expect(html).toContain("<span>Copy JSON</span>");
    expect(html).toContain('aria-label="Close request details"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html.match(/>Raw<\/span>/g)).toHaveLength(4);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("renders the empty image inspector with one shared scroll owner", () => {
    const html = renderImageProcessor();

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Image controls</h2>");
    expect(html).toContain("No image selected");
    expect(html).toContain("Add images");
    expect(html).toContain('aria-label="Show image canvas"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).not.toContain("Export image");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("renders active edit controls and export actions through the shared detail panel", () => {
    const html = renderImageProcessorView({ initialImages: [image] });

    expect(html).toContain("<h2>invoice.png</h2>");
    expect(html).toContain("1200 × 800 px");
    expect(html).toContain('<img src="data:image/png;base64,aW1hZ2U=" alt="Preview"');
    expect(html).toContain('role="radiogroup" aria-label="Options"');
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain('aria-label="Geometry"');
    expect(html).toContain('aria-label="Appearance"');
    expect(html).toContain("Crop");
    expect(html).toContain("Transform");
    expect(html).toContain("Adjustments");
    expect(html).toContain("Presets");
    expect(html).toContain("Edits");
    expect(html).toContain("Export image");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("renders markup controls and their disabled initial actions", () => {
    const html = renderImageProcessorView({ initialImages: [image], initialEditorMode: "markup" });

    expect(html).toContain('aria-label="Markup controls"');
    expect(html).toContain("Tool");
    expect(html).toContain("Style");
    expect(html).toContain('aria-label="Pen"');
    expect(html).toMatch(/<button aria-label="Undo markup"[^>]* disabled /);
    expect(html).toMatch(/<button aria-label="Redo markup"[^>]* disabled /);
    expect(html).toMatch(/<button aria-label="Delete selected markup"[^>]* disabled /);
    expect(html).toMatch(/<button aria-label="Clear markup"[^>]* disabled /);
    expect(html).not.toContain('aria-label="Geometry"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });

  test("disables destructive and export actions while cropping", () => {
    const html = renderImageProcessorView({ initialImages: [image], initialCropActive: true });

    expect(html).toContain("Apply");
    expect(html).toContain("Cancel");
    expect(html).toMatch(/<button aria-label="Add images"[^>]* disabled /);
    expect(html).toMatch(/<button aria-label="Remove image"[^>]* disabled /);
    expect(html).toMatch(/<button[^>]* disabled ><span class="k2b-button__label"><i class="ti ti-download"><\/i> (?:<!--!\$-->)?Export image/);
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });
});
