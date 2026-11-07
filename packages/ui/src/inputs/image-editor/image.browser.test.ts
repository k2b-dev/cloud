import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../test/browser";
import type * as ImageApi from "./image";
import type * as ModelApi from "./model";
import type * as RenderApi from "./render";

setDefaultTimeout(30_000);
const entry = resolve(import.meta.dir, "image.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `import * as image from './image'; import * as model from './model'; import * as renderer from './render'; window.editor={...image,...model,...renderer};`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle image editor engine fixture");
const script = await build.outputs[0]!.text();
type Api = typeof ImageApi & typeof ModelApi & typeof RenderApi;
const run = <T>(page: Page, work: (api: Api) => T | Promise<T>): Promise<T> => page.evaluate(`(${work.toString()})(window.editor)`);
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let originalRequests = 0;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/engine.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/original.jpg") {
        originalRequests++;
        return new Response(Bun.file(resolve(import.meta.dir, "fixtures/photo.jpg")));
      }
      if (path === "/photo.jpg" || path === "/logo.png") return new Response(Bun.file(resolve(import.meta.dir, `fixtures${path}`)));
      return new Response('<!doctype html><script src="/engine.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
const open = async () => {
  const page = await browser.newPage();
  await page.goto(server.url.href);
  return page;
};

describe(`ImageEditor shared renderer and export (${browserName})`, () => {
  test("photo and transparent logo preview match the downsampled export within three color levels", async () => {
    const page = await open();
    try {
      const results = await run(page, async (api) => {
        const results = [];
        for (const source of ["/photo.jpg", "/logo.png"]) {
          const preview = await api.loadImageEditorPreview({ source, features: {} }, new AbortController().signal);
          const states = [
            api.initialImageEditorState(),
            { ...api.initialImageEditorState(), look: "warm" as const, lookStrength: 0.65 },
            ...(["mono-hard", "faded", "vintage"] as const).map((look) => ({ ...api.initialImageEditorState(), look, lookStrength: 0.65 })),
            {
              ...api.initialImageEditorState(),
              adjustments: { brightness: 0.6, contrast: 0.7, saturation: 0.3, warmth: -0.4, vignette: 0.5, grain: 0 },
            },
            {
              ...api.initialImageEditorState(),
              adjustments: { brightness: 1.2, contrast: 1.3, saturation: 1.4, warmth: 0.3, vignette: 0, grain: 0.35 },
            },
            {
              ...api.initialImageEditorState(),
              adjustments: { brightness: 1.2, contrast: 1.3, saturation: 1.4, warmth: 0.3, vignette: 0, grain: 0 },
            },
            {
              ...api.initialImageEditorState(),
              adjustments: { brightness: 1, contrast: 1, saturation: 1, warmth: 0, vignette: 0, grain: 1 },
            },
            {
              ...api.initialImageEditorState(),
              rotation: 90 as const,
              straighten: 7,
              flipX: true,
              crop: { x: 0.1, y: 0.15, width: 0.7, height: 0.6 },
            },
          ];
          for (const [index, state] of states.entries()) {
            const canvases = Array.from({ length: 6 }, () => document.createElement("canvas"));
            const [large, small, reduced, scratch, geometry, geometryScratch] = canvases;
            if (!large || !small || !reduced || !scratch || !geometry || !geometryScratch) throw new Error("missing test canvas");
            large.width = 1600;
            large.height = 1067;
            for (const canvas of [small, reduced, geometry]) {
              canvas.width = 400;
              canvas.height = 267;
            }
            api.renderImageEditor(preview.image, preview.sourceSize, state, large, scratch);
            api.renderImageEditor(preview.image, preview.sourceSize, state, small, scratch);
            api.renderImageEditor(
              preview.image,
              preview.sourceSize,
              {
                ...api.initialImageEditorState(),
                rotation: state.rotation,
                straighten: state.straighten,
                flipX: state.flipX,
                crop: state.crop,
              },
              geometry,
              geometryScratch,
            );
            const context = reduced.getContext("2d")!;
            context.imageSmoothingQuality = "high";
            context.drawImage(large, 0, 0, reduced.width, reduced.height);
            const a = context.getImageData(0, 0, 400, 267).data;
            const b = small.getContext("2d")!.getImageData(0, 0, 400, 267).data;
            const alpha = geometry.getContext("2d")!.getImageData(0, 0, 400, 267).data;
            let difference = 0;
            let alphaDifference = 0;
            let opaqueBackground = 0;
            for (let i = 0; i < a.length; i += 4) {
              difference += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
              alphaDifference = Math.max(alphaDifference, Math.abs(b[i + 3]! - alpha[i + 3]!));
              if (alpha[i + 3] === 0 && b[i + 3] !== 0) opaqueBackground++;
            }
            results.push({ source, index, mean: difference / (400 * 267 * 3), alphaDifference, opaqueBackground });
            for (const canvas of canvases) canvas.width = canvas.height = 0;
          }
          preview.dispose();
        }
        return results;
      });
      for (const result of results) {
        expect(result.mean, `${result.source}, state ${result.index}`).toBeLessThanOrEqual(3);
        expect(result.alphaDifference).toBeLessThanOrEqual(1);
        expect(result.opaqueBackground).toBe(0);
      }
    } finally {
      await page.close();
    }
  });

  test("caller preview keeps the original unloaded until export and keeps original dimensions", async () => {
    const page = await open();
    try {
      originalRequests = 0;
      const result = await run(page, async (api) => {
        const props = {
          source: "/original.jpg",
          sourceSize: { width: 1600, height: 1067, type: "image/jpeg" },
          previews: [{ source: "/photo.jpg", width: 1600, height: 1067 }],
          features: {},
        };
        const preview = await api.loadImageEditorPreview(props, new AbortController().signal);
        const before = performance.getEntriesByType("resource").filter((item) => item.name.endsWith("/original.jpg")).length;
        const output = await api.exportImageEditor(props, api.initialImageEditorState(), { maxLongEdge: 800 });
        preview.dispose();
        return {
          before,
          width: output.width,
          originalWidth: output.originalWidth,
          originalHeight: output.originalHeight,
          downscaled: output.downscaled,
          type: output.type,
          released: preview.image.width,
        };
      });
      expect(originalRequests).toBe(1);
      expect(result).toEqual({
        before: 0,
        width: 800,
        originalWidth: 1600,
        originalHeight: 1067,
        downscaled: true,
        type: "image/jpeg",
        released: 0,
      });
    } finally {
      await page.close();
    }
  });

  test("internal preview is bounded while output size follows the original and caller MP limit", async () => {
    const page = await open();
    try {
      const result = await run(page, async (api) => {
        const source = document.createElement("canvas");
        source.width = 3000;
        source.height = 1500;
        const blob = await new Promise<Blob>((resolve) => source.toBlob((value) => resolve(value!), "image/png"));
        source.width = source.height = 0;
        const props = { source: blob, features: {}, maxOutputMegapixels: 1 };
        const preview = await api.loadImageEditorPreview(props, new AbortController().signal);
        const output = await api.exportImageEditor(props, api.initialImageEditorState());
        const size = {
          preview: [preview.width, preview.height],
          original: [output.originalWidth, output.originalHeight],
          width: output.width,
          height: output.height,
          downscaled: output.downscaled,
        };
        preview.dispose();
        return size;
      });
      expect(result.preview).toEqual([2048, 1024]);
      expect(result.original).toEqual([3000, 1500]);
      expect(result.width * result.height).toBeLessThanOrEqual(1_000_000);
      expect(result.downscaled).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("invalid caller previews and already cancelled work never fetch the original", async () => {
    const page = await open();
    try {
      originalRequests = 0;
      expect(
        await run(page, async (api) => {
          let failures = 0;
          const invalid = {
            source: "/original.jpg",
            features: {},
            sourceSize: { width: 1600, height: 1067 },
            previews: [{ source: "/photo.jpg", width: 0, height: 0 }],
          };
          try {
            await api.loadImageEditorPreview(invalid, new AbortController().signal);
          } catch {
            failures++;
          }
          const controller = new AbortController();
          controller.abort();
          try {
            await api.exportImageEditor(
              { source: "/original.jpg", features: {} },
              api.initialImageEditorState(),
              undefined,
              controller.signal,
            );
          } catch {
            failures++;
          }
          return failures;
        }),
      ).toBe(2);
      expect(originalRequests).toBe(0);
    } finally {
      await page.close();
    }
  });

  test("failed output keeps its requested size and returns an explicit smaller retry suggestion", async () => {
    const page = await open();
    try {
      const result = await run(page, async (api) => {
        // Probe supported formats first, then refuse the requested output allocation in the real encoder seam.
        await api.supportedImageEditorFormats();
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback) {
          callback(null);
        };
        try {
          await api.exportImageEditor({ source: "/photo.jpg", features: {}, maxOutputMegapixels: "device" }, api.initialImageEditorState());
          return { failed: false, suggested: 0 };
        } catch (error) {
          return {
            failed: error instanceof api.ImageEditorSizeError,
            suggested: error instanceof api.ImageEditorSizeError ? error.suggestedMegapixels : 0,
          };
        } finally {
          HTMLCanvasElement.prototype.toBlob = original;
        }
      });
      expect(result.failed).toBe(true);
      expect(result.suggested).toBeCloseTo(0.8536, 4);
    } finally {
      await page.close();
    }
  });

  test("cancellation settles even when a browser encoder callback never arrives", async () => {
    const page = await open();
    try {
      expect(
        await run(page, async (api) => {
          await api.supportedImageEditorFormats();
          const controller = new AbortController();
          const original = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function () {
            controller.abort(new DOMException("Cancelled", "AbortError"));
          };
          try {
            await api.exportImageEditor(
              { source: "/photo.jpg", features: {} },
              api.initialImageEditorState(),
              undefined,
              controller.signal,
            );
            return false;
          } catch (error) {
            return error instanceof DOMException && error.name === "AbortError";
          } finally {
            HTMLCanvasElement.prototype.toBlob = original;
          }
        }),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("transparent export retains alpha, JPEG uses white, and redaction covers later annotations", async () => {
    const page = await open();
    try {
      const result = await run(page, async (api) => {
        const state = api.initialImageEditorState();
        state.adjustments.brightness = 0.4;
        state.annotations = [
          {
            tool: "redact",
            points: [
              { x: 0.4, y: 0.4 },
              { x: 0.6, y: 0.6 },
            ],
            color: "#000",
            width: 1,
          },
          {
            tool: "rect",
            points: [
              { x: 0.45, y: 0.45 },
              { x: 0.55, y: 0.55 },
            ],
            color: "#ff0000",
            width: 100,
          },
        ];
        const outputs = [];
        for (const format of ["image/png", "image/jpeg"] as const) {
          const output = await api.exportImageEditor({ source: "/logo.png", features: {} }, state, { format });
          const preview = await api.loadImageEditorPreview({ source: output.blob, features: {} }, new AbortController().signal);
          const ctx = preview.image.getContext("2d")!;
          outputs.push({
            format: output.type,
            corner: [...ctx.getImageData(0, 0, 1, 1).data],
            redaction: [...ctx.getImageData(800, 533, 1, 1).data],
          });
          preview.dispose();
        }
        return outputs;
      });
      expect(result[0]?.corner).toEqual([0, 0, 0, 0]);
      expect(result[1]?.corner).toEqual([255, 255, 255, 255]);
      expect(result[0]?.redaction).toEqual([0, 0, 0, 255]);
      expect(result[1]?.redaction).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  test("unsupported same-type inputs choose PNG for alpha and JPEG for opaque pixels", async () => {
    const page = await open();
    try {
      const result = await run(page, async (api) => {
        const outputs = [];
        for (const source of ["/photo.jpg", "/logo.png"]) {
          const blob = await (await fetch(source)).blob();
          const unknownType = blob.slice(0, blob.size, "application/octet-stream");
          const output = await api.exportImageEditor({ source: unknownType, features: {} }, api.initialImageEditorState());
          outputs.push({ type: output.type, actual: output.blob.type });
        }
        return outputs;
      });
      expect(result).toEqual([
        { type: "image/jpeg", actual: "image/jpeg" },
        { type: "image/png", actual: "image/png" },
      ]);
    } finally {
      await page.close();
    }
  });

  test("encoder capability checks reject a silently substituted PNG and release all object URLs", async () => {
    const page = await open();
    try {
      const result = await run(page, async (api) => {
        const originalEncode = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          return originalEncode.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
        };
        const active = new Set<string>();
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = (blob) => {
          const url = originalCreate(blob);
          active.add(url);
          return url;
        };
        URL.revokeObjectURL = (url) => {
          active.delete(url);
          originalRevoke(url);
        };
        try {
          const formats = await api.supportedImageEditorFormats();
          let refused = false;
          try {
            await api.exportImageEditor({ source: "/photo.jpg", features: {} }, api.initialImageEditorState(), { format: "image/webp" });
          } catch {
            refused = true;
          }
          const preview = await api.loadImageEditorPreview({ source: "/logo.png", features: {} }, new AbortController().signal);
          preview.dispose();
          return { formats, refused, active: active.size };
        } finally {
          HTMLCanvasElement.prototype.toBlob = originalEncode;
          URL.createObjectURL = originalCreate;
          URL.revokeObjectURL = originalRevoke;
        }
      });
      expect(result).toEqual({ formats: ["image/jpeg", "image/png"], refused: true, active: 0 });
    } finally {
      await page.close();
    }
  });
});
