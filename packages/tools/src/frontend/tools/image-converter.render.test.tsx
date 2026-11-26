import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import type { ImageConverterEntry } from "./ImageConverter.island";

const root = mkdtempSync(join(tmpdir(), "tools-image-converter-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

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
  test("offers to add images, says the conversion stays in the browser, and keeps the settings closed while empty", () => {
    const html = renderConverter();

    expect(html).toContain("Add images");
    expect(html).toContain("conversion stays in this browser");
    expect(html).not.toContain("Convert and export");
    expect(html).not.toContain("Export all (");
  });

  test("renders image metadata, its deeds and the settings beside the list", () => {
    const html = renderConverter([image()]);

    expect(html).toContain("team-photo.png");
    // Solid may mark each inserted value with an empty `<!--!$-->` comment.
    expect(html).toMatch(/800(?:<!--!\$-->)? × (?:<!--!\$-->)?1200(?:<!--!\$-->)? px/);
    expect(html).toContain('aria-label="Actions for team-photo.png"');
    expect(html).toContain("Convert and export");
    expect(html).toContain("Target image format");
    expect(html).toMatch(/Export all \([^)]*1[^)]*\)/);
    expect(html).toContain("Copy as Base64");
    expect(html).not.toContain("Export selected");
  });

  test("a selection turns the status row into the bar of what can be done with it", () => {
    const html = renderConverter([image(true)]);

    expect(html).toContain("1 selected");
    expect(html).toContain("Export selected (1)");
    expect(html).toContain("Copy selected (1) as Base64 HTML");
    expect(html).toContain("Clear selection");
    // the copy of the settings pane copies the selection too, and says so
    expect(html).not.toContain("Copy as Base64<");
    expect(html.match(/Copy selected \(1\) as Base64 HTML/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("image intake states in the main workspace", () => {
  const file = new File([], "IMG_0001.HEIC", { type: "image/heic" });
  const renderItems = (initialItems: NonNullable<Parameters<typeof ImageConverterView>[0]>["initialItems"]) =>
    renderToString(() => createComponent(ImageConverterView, { initialItems }));

  test("a loading image says its stage and has no deeds", () => {
    const html = renderItems([{ status: "loading", id: "loading", file, stage: "loading-decoder" }]);

    expect(html).toContain("IMG_0001.HEIC");
    expect(html).toContain("Loading the HEIC decoder");
    expect(html).not.toContain("Remove IMG_0001.HEIC");
  });

  test("a file that failed keeps its reason, recovery and remove action, with the settings closed", () => {
    const html = renderItems([{ status: "failed", id: "failed", file, reason: "decode-failed" }]);

    // the failure stands in the file's own row, in the list: no band across the page per file
    expect(html).not.toContain('data-k2-part="Notice"');
    const row = html.slice(html.indexOf('data-k2-part="Row"'));
    expect(row).toContain("IMG_0001.HEIC");
    expect(row).toContain("This image could not be read.");
    expect(row).toContain("Export it again from the source app, or choose another file.");
    expect(html).toContain("Remove IMG_0001.HEIC");
    expect(html).not.toContain("Convert and export");
    expect(html).not.toContain("Export all (");
  });
});
