import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ImageConverterEntry } from "./ImageConverter.island";

const root = mkdtempSync(join(tmpdir(), "tools-image-converter-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { ImageConverterView } = await import("./ImageConverter.island");

const image = (selected = false): ImageConverterEntry => ({
  id: "image-1",
  file: new File(["image"], "team-photo.png", { type: "image/png" }),
  source: new Blob(["image"], { type: "image/png" }),
  previewUrl: "data:image/png;base64,aW1hZ2U=",
  width: 1200,
  height: 800,
  rotation: 90,
  selected,
});

const renderConverter = (initialImages: readonly ImageConverterEntry[] = []) =>
  renderToString(() => createComponent(ImageConverterView, { initialImages }));

describe("Image Converter", () => {
  test("renders an accessible browser-local dropzone and disabled export state", () => {
    const html = renderConverter();

    expect(html).toContain("Drop images here or click to choose");
    expect(html).toContain("conversion stays in this browser");
    expect(html).toContain("Convert and export");
    expect(html).toMatch(/id="k2b-workspace-detail-image-converter-settings"[^>]* hidden/);
    expect(html).not.toContain('aria-label="Open export settings"');
    expect(html).not.toContain('aria-label="Show images"');
    expect(html).toContain('aria-label="Target image format"');
    expect(html).not.toContain("Export all (");
  });

  test("renders image metadata and per-image overlay actions", () => {
    const html = renderConverter([image()]);

    expect(html).toContain("team-photo.png");
    expect(html).not.toMatch(/id="k2b-workspace-detail-image-converter-settings"[^>]* hidden/);
    expect(html.replace(/<!--.*?-->/g, "")).toContain("800 × 1200 px");
    expect(html).toContain('aria-label="Select team-photo.png"');
    expect(html).toContain('aria-label="Rotate team-photo.png clockwise"');
    expect(html).toContain('aria-label="Remove team-photo.png"');
    expect(html).toMatch(/Export all \([^)]*1[^)]*\)/);
    expect(html).toContain("Copy all (1) as Base64 HTML");
    expect(html).toContain('aria-label="More export options for all images"');
    expect(html).not.toContain("Export destination");
    expect(html).not.toContain("bg-[var(--ui-surface)]/90");
    expect(html).not.toContain("Export selected");
  });

  test("adds separate all and selected export actions when selection is active", () => {
    const html = renderConverter([image(true)]);

    expect(html).toContain("1 selected");
    expect(html).toMatch(/Export all \([^)]*1[^)]*\)/);
    expect(html).toContain("Export selected (1)");
    expect(html).toContain("Copy all (1) as Base64 HTML");
    expect(html).toContain("Copy selected (1) as Base64 HTML");
    expect(html).toContain('aria-label="More export options for selected images"');
    expect(html).toContain('data-selected="true"');
  });
});

describe("image intake states in the main workspace", () => {
  const file = new File([], "IMG_0001.HEIC", { type: "image/heic" });
  const renderItems = (initialItems: NonNullable<Parameters<typeof ImageConverterView>[0]>["initialItems"]) =>
    renderToString(() => createComponent(ImageConverterView, { initialItems }));
  test("a loading card announces its stage and has no item actions", () => {
    const html = renderItems([{ status: "loading", id: "loading", file, stage: "loading-decoder" }]);
    expect(html).toContain('data-status="loading"');
    expect(html).toContain("IMG_0001.HEIC");
    expect(html).toContain("Loading the HEIC decoder");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('aria-label="Remove IMG_0001.HEIC"');
    expect(html).not.toContain('aria-label="Select IMG_0001.HEIC"');
  });
  test("a failed card keeps the reason, recovery and remove action in the main area, with the settings still closed", () => {
    const html = renderItems([{ status: "failed", id: "failed", file, reason: "decode-failed" }]);
    const main = html.slice(0, html.indexOf('id="k2b-workspace-detail-image-converter-settings"'));
    expect(main).toContain('data-status="failed"');
    expect(main).toContain("IMG_0001.HEIC");
    expect(main).toContain("This image could not be read.");
    expect(main).toContain("Export it again from the source app, or choose another file.");
    expect(main).toContain('aria-label="Remove IMG_0001.HEIC"');
    expect(html).toMatch(/id="k2b-workspace-detail-image-converter-settings"[^>]* hidden/);
    expect(html).not.toContain("1 image ready");
    expect(html).not.toContain("Export all (");
  });
});
