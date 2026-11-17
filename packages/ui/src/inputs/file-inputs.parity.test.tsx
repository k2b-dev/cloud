import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-file-inputs-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { FileDropzone, ImageCropper, ImageInput } = await import("./FileInputs");
const {
  clampImageCropRect,
  getInitialImageCropRect,
  imageCropRectToPixels,
  normalizeImageCropRotation,
  resizeImageCropAroundCenter,
  rotateImageCropRight,
} = await import("./image-crop");

describe("@k2b/ui file input parity", () => {
  test("keeps dropzone single-file and busy semantics", () => {
    const single = renderToString(() =>
      createComponent(FileDropzone, {
        label: "Attachment",
        accept: "image/*",
        multiple: false,
        onDrop: () => {},
      }),
    );
    const busy = renderToString(() =>
      createComponent(FileDropzone, {
        busy: true,
        onDrop: () => {},
      }),
    );

    expect(single).toContain('accept="image/*"');
    expect(single).not.toContain(" multiple");
    expect(busy).toContain("Uploading…");
    expect(busy).toContain(" disabled");
  });

  test("stacks dropzone copy in the Cloud title, subtitle, and hint hierarchy", () => {
    const html = renderToString(() =>
      createComponent(FileDropzone, {
        subtitle: "PNG, JPG, or WebP",
        hint: "One image",
        onDrop: () => {},
      }),
    );

    expect(html).toContain("Drop files or click to choose");
    expect(html).toContain('class="k2b-dropzone__subtitle"');
    expect(html).toContain('class="k2b-dropzone__hint"');
    expect(html.indexOf("k2b-dropzone__subtitle")).toBeLessThan(html.indexOf("k2b-dropzone__hint"));
  });

  test("renders controlled image actions without invoking browser transforms during SSR", () => {
    const html = renderToString(() =>
      createComponent(ImageInput, {
        label: "Avatar",
        "aria-label": "Profile avatar",
        value: () => "data:image/png;base64,abc",
        variant: "small",
        round: true,
        onValueChange: () => {},
      }),
    );

    expect(html).toContain('data-variant="small"');
    expect(html).toContain('data-round="true"');
    expect(html).toContain('aria-labelledby="k2b-field-00-label"');
    expect(html).not.toContain('aria-label="Profile avatar"');
    expect(html).toContain('aria-label="Change image"');
    expect(html).toContain('aria-label="Remove image"');
    expect(html).toContain("ti ti-pencil");
    expect(html).toContain("k2b-icon-button");
    expect(html).toContain("image/svg+xml");
  });

  test("renders cropper loading state safely during SSR", () => {
    const html = renderToString(() =>
      createComponent(ImageCropper, {
        source: "data:image/png;base64,abc",
        aspect: { width: 1, height: 1 },
      }),
    );

    expect(html).toContain("k2b-image-cropper");
    expect(html).toContain("Preparing image…");
  });

  test("keeps the ported crop geometry identical to the Cloud helpers", () => {
    expect(rotateImageCropRight(0)).toBe(90);
    expect(rotateImageCropRight(270)).toBe(0);
    expect(normalizeImageCropRotation(-90)).toBe(270);

    const initial = getInitialImageCropRect({ width: 1600, height: 900 }, { width: 1, height: 1 });
    expect(initial.width).toBeLessThan(initial.height);
    expect(Math.round(initial.x * 100)).toBe(26);
    expect(Math.round(initial.y * 100)).toBe(7);
    expect(Math.round(((initial.width * 1600) / (initial.height * 900)) * 100)).toBe(100);

    expect(clampImageCropRect({ x: 0.9, y: -0.2, width: 0.5, height: 1.4 }, { width: 800, height: 600 }, "free")).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    });

    expect(
      resizeImageCropAroundCenter({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, { width: 1000, height: 1000 }, { width: 1, height: 1 }, 2),
    ).toEqual({ x: 0.35, y: 0.35, width: 0.3, height: 0.3 });

    expect(imageCropRectToPixels({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, { width: 400, height: 300 })).toEqual({
      x: 100,
      y: 30,
      width: 200,
      height: 240,
    });
    expect(imageCropRectToPixels({ x: 2, y: -1, width: 0.5, height: 2 }, { width: 100, height: 100 })).toEqual({
      x: 92,
      y: 0,
      width: 8,
      height: 100,
    });
  });
});
