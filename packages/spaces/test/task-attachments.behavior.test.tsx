import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("Spaces task attachments", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("opens attached images in the shared lightbox with a download action", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: TaskAttachmentsSection } = await import("../src/frontend/[id]/_components/detail/TaskAttachmentsSection");
    const dispose = render(
      () =>
        createComponent(TaskAttachmentsSection, {
          spaceId: "Space1",
          itemId: "Item01",
          attachments: [
            {
              id: "File01",
              filename: "broken-dialog.webp",
              mimeType: "image/webp",
              sizeBytes: 42_000,
              kind: "image",
              createdAt: "2026-08-20T10:00:00.000Z",
            },
          ],
          canWrite: false,
          onChanged: () => undefined,
        }),
      dom.root,
    );

    const attachment = dom.root.querySelector<HTMLButtonElement>('[aria-label="Preview broken-dialog.webp"]');
    expect(attachment).not.toBeNull();
    attachment!.click();
    await Promise.resolve();

    const dialog = dom.document.querySelector<HTMLDialogElement>('dialog[aria-label="Image lightbox"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector<HTMLImageElement>('img[alt="broken-dialog.webp"]')?.src).toContain(
      "/api/spaces/Space1/items/Item01/attachments/File01/content",
    );
    expect(dialog?.querySelector<HTMLAnchorElement>('a[aria-label="Download image"]')?.href).toContain(
      "/attachments/File01/content?download=true",
    );

    dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close lightbox"]')?.click();
    dispose();
    dom.cleanup();
  });
});
