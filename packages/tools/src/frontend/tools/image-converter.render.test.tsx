import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ImageConverterView, type ImageConverterEntry } from "./ImageConverter.island";

const image = (selected = false): ImageConverterEntry => ({
  id: "image-1",
  file: new File(["image"], "team-photo.png", { type: "image/png" }),
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
    expect(html).toContain("800 × 1200 px");
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
