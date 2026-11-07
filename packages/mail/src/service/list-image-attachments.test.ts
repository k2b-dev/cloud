import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_PREVIEW_BYTES } from "../attachment-preview-policy";
import { isListImageAttachment } from "./list-image-attachments";

const image = { contentType: "image/jpeg", sizeBytes: 4096, disposition: "attachment", contentId: null };

describe("Mail list image qualification", () => {
  test("accepts only previewable raster types with normalized base MIME types", () => {
    for (const contentType of ["image/jpeg", "image/png", "image/gif", "image/webp", " Image/PNG ; name=photo.png"])
      expect(isListImageAttachment({ ...image, contentType })).toBe(true);
    for (const contentType of ["application/pdf", "image/svg+xml", "image/tiff", "application/octet-stream"])
      expect(isListImageAttachment({ ...image, contentType })).toBe(false);
  });

  test("includes the exact size boundaries and excludes tracking images and unsafe sizes", () => {
    for (const sizeBytes of [4096, MAX_IMAGE_PREVIEW_BYTES]) expect(isListImageAttachment({ ...image, sizeBytes })).toBe(true);
    for (const sizeBytes of [0, 4095, MAX_IMAGE_PREVIEW_BYTES + 1, -1, 4096.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isListImageAttachment({ ...image, sizeBytes })).toBe(false);
  });

  test("excludes inline CID parts but allows an unreferenced inline image or an attachment with a CID", () => {
    expect(isListImageAttachment({ ...image, disposition: "inline", contentId: "photo@example.test" })).toBe(false);
    expect(isListImageAttachment({ ...image, disposition: "inline", contentId: "" })).toBe(false);
    expect(isListImageAttachment({ ...image, disposition: "inline" })).toBe(true);
    expect(isListImageAttachment({ ...image, disposition: null })).toBe(true);
    expect(isListImageAttachment({ ...image, contentId: "photo@example.test" })).toBe(true);
  });
});
