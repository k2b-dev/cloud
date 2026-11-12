import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

/** The list item of the named attachment: its open button and preview. */
const item = (root: HTMLElement, filename: string) =>
  [...root.querySelectorAll<HTMLElement>(".k2b-file-grid__item")].find(
    (entry) => entry.querySelector(".k2b-file-grid__name")?.textContent === filename,
  );
/** Lets the Lightbox resolve the shown file's address. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("Spaces task attachments", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("opens attached images in the shared Lightbox with Download and Save to Files", async () => {
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

    const attachment = item(dom.root, "broken-dialog.webp")?.querySelector<HTMLButtonElement>(".k2b-file-grid__open");
    expect(attachment).not.toBeNull();
    // The row names the file by its kind and size, and downloads it from its action slot.
    expect(item(dom.root, "broken-dialog.webp")?.querySelector(".k2b-file-grid__meta")?.textContent).toMatch(/^Image · 41/);
    expect(dom.root.querySelector<HTMLAnchorElement>('a[aria-label="Download broken-dialog.webp"]')?.getAttribute("href")).toBe(
      "/api/spaces/Space1/items/Item01/attachments/File01/content?download=true",
    );
    attachment!.click();
    await settle();

    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox");
    expect(dialog?.getAttribute("aria-label")).toBe("broken-dialog.webp");
    expect(dialog?.querySelector<HTMLImageElement>('img[alt="broken-dialog.webp"]')?.src).toContain(
      "/api/spaces/Space1/items/Item01/attachments/File01/content",
    );
    expect(dialog?.querySelector<HTMLAnchorElement>('a[aria-label="Download"]')?.href).toContain(
      "/attachments/File01/content?download=true",
    );
    expect(dialog?.querySelector(".k2b-lightbox__action")?.textContent).toMatch(/^Save/);

    dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    expect(dom.document.querySelector("dialog.k2b-lightbox")).toBeNull();
    dispose();
    dom.cleanup();
  });

  test("shows a video's first frame and plays it in the Lightbox, which steps on to the images", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    // Solid delegated its clicks to the document of the first import.
    delegateEvents(["click"], dom.document);
    const { default: TaskAttachmentsSection } = await import("../src/frontend/[id]/_components/detail/TaskAttachmentsSection");
    const dispose = render(
      () =>
        createComponent(TaskAttachmentsSection, {
          spaceId: "Space1",
          itemId: "Item01",
          attachments: [
            {
              id: "Image1",
              filename: "Board.webp",
              mimeType: "image/webp",
              sizeBytes: 42_000,
              kind: "image",
              createdAt: "2026-10-07T09:59:00.000Z",
            },
            {
              id: "Reel01",
              filename: "Reel for approval.mov",
              mimeType: "video/quicktime",
              sizeBytes: 4_200_000,
              kind: "file",
              createdAt: "2026-10-07T10:00:00.000Z",
            },
            {
              id: "Notes1",
              filename: "notes.pdf",
              mimeType: "application/pdf",
              sizeBytes: 12_000,
              kind: "file",
              createdAt: "2026-10-07T10:01:00.000Z",
            },
          ],
          canWrite: false,
          onChanged: () => undefined,
        }),
      dom.root,
    );

    const content = "/api/spaces/Space1/items/Item01/attachments/Reel01/content";
    const row = item(dom.root, "Reel for approval.mov");
    expect(row).not.toBeUndefined();
    expect(row!.querySelector(".k2b-file-grid__preview video")?.getAttribute("src")).toBe(`${content}#t=0.001`);
    const tile = row!.querySelector<HTMLButtonElement>(".k2b-file-grid__open")!;
    // Only images and playable videos are listed; the section counts them.
    expect(dom.root.querySelectorAll(".k2b-file-grid__item").length).toBe(2);
    expect(dom.root.textContent).not.toContain("notes.pdf");

    tile!.click();
    await settle();
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox");
    expect(dialog?.getAttribute("aria-label")).toBe("Reel for approval.mov");
    // The shared player starts at the first frame, so the address carries its time fragment.
    expect(dialog?.querySelector<HTMLVideoElement>(".k2b-lightbox__video video")?.getAttribute("src")).toBe(`${content}#t=0.001`);
    expect(dialog?.querySelector<HTMLAnchorElement>('a[aria-label="Download"]')?.getAttribute("href")).toBe(`${content}?download=true`);
    // Videos come first, as in the list; the next file is the image.
    dialog?.querySelector<HTMLButtonElement>('button[aria-label="Next file"]')?.click();
    await settle();
    expect(dialog?.getAttribute("aria-label")).toBe("Board.webp");
    expect(dialog?.querySelector<HTMLImageElement>('img[alt="Board.webp"]')).not.toBeNull();

    dispose();
    dom.cleanup();
  });
});
