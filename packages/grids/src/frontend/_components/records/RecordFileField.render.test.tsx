import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Field, GridFile } from "../../../service";
import "../ssr-test-plugin";

const {
  default: RecordFileField,
  recordFileContentHref,
  recordFileHref,
  recordFileRemovalPrompt,
  refreshFilesAfterCommittedChange,
} = await import("./RecordFileField");

const image = {
  id: "22222222-2222-4222-8222-222222222222",
  filename: "camera.png",
  mimeType: "image/png",
  sizeBytes: 1024,
} as GridFile;

const secondImage = {
  ...image,
  id: "55555555-5555-4555-8555-555555555555",
  filename: "camera-side.png",
} as GridFile;

const field = {
  id: "11111111-1111-4111-8111-111111111111",
  tableId: "33333333-3333-4333-8333-333333333333",
  name: "Images",
  type: "file",
  config: {},
} as Field;

describe("RecordFileField", () => {
  test("notifies Finalization immediately when a committed file change cannot be refreshed", async () => {
    const events: string[] = [];

    await refreshFilesAfterCommittedChange(
      () => events.push("changed"),
      async () => {
        events.push("refresh");
        throw new Error("offline");
      },
      (error) => events.push(error instanceof Error ? `error:${error.message}` : "error"),
    );

    expect(events).toEqual(["changed", "refresh", "error:offline"]);
  });

  test("appends the file path before preserving custom app page parameters", () => {
    expect(recordFileHref({ endpoint: `/api/files/${field.id}?item_id=item-1` }, image)).toBe(
      `/api/files/${field.id}/${image.id}?item_id=item-1`,
    );
    expect(recordFileContentHref({ endpoint: `/api/files/${field.id}?item_id=item-1` }, image, true)).toBe(
      `/api/files/${field.id}/${image.id}/content?item_id=item-1&inline=true`,
    );
  });

  test("offers atomic replace and honest removal wording to writers", () => {
    const html = renderToString(() =>
      createComponent(RecordFileField, {
        tableId: field.tableId,
        recordId: "44444444-4444-4444-8444-444444444444",
        field,
        canWrite: true,
        initialFiles: [image],
        endpoint: `/api/files/${field.id}?item_id=item-1`,
      }),
    );

    expect(html).toContain(`aria-label="Replace ${image.filename}"`);
    expect(html).toContain(`aria-label="Remove ${image.filename} from record"`);
    expect(recordFileRemovalPrompt(image.filename)).toBe(
      `Remove "${image.filename}" from this record? Protected history or artifacts may retain the exact file. Without a protected reference, it may be cleaned up later.`,
    );
  });

  test("renders every image as a small preview without removing the file row", () => {
    const html = renderToString(() =>
      createComponent(RecordFileField, {
        tableId: field.tableId,
        recordId: "44444444-4444-4444-8444-444444444444",
        field,
        canWrite: false,
        initialFiles: [image, secondImage],
        endpoint: `/api/files/${field.id}?item_id=item-1`,
      }),
    );

    expect(html).toContain(`aria-label="Preview ${image.filename}"`);
    expect(html).toContain("grids-record-file-thumbnail");
    expect(html).toContain(`src="/api/files/${field.id}/${image.id}/content?item_id=item-1&amp;inline=true"`);
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).toContain(image.filename);
    expect(html).not.toContain(`aria-label="Replace ${image.filename}"`);
    expect(html).not.toContain(`aria-label="Remove ${image.filename} from record"`);
  });

  test("hard-limits thumbnails independently of generated utility coverage", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../../../styles/app.css")).text();

    expect(css).toMatch(/\.grids-record-file-thumbnail\s*\{[^}]*width:\s*5rem;[^}]*height:\s*5rem;[^}]*flex:\s*0 0 5rem;/);
  });
});
