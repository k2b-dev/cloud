import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
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

  test("shows a video's first frame and plays it in a dialog with its download", async () => {
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
    const tile = dom.root.querySelector<HTMLButtonElement>('[aria-label="Play Reel for approval.mov"]');
    expect(tile).not.toBeNull();
    expect(tile!.querySelector("video")?.getAttribute("src")).toBe(`${content}#t=0.001`);
    // Only images and playable videos get a tile; the section counts them.
    expect(dom.root.querySelectorAll("button[aria-label]").length).toBe(1);
    expect(dom.root.textContent).not.toContain("notes.pdf");

    tile!.click();
    await Promise.resolve();
    const dialog = dom.document.querySelector(".spaces-video-dialog");
    expect(dialog).not.toBeNull();
    const video = dialog!.querySelector<HTMLVideoElement>(".k2b-video-player__video");
    expect(video?.getAttribute("src")).toBe(`${content}#t=0.001`);
    expect(video?.getAttribute("aria-label")).toBe("Reel for approval.mov");
    expect(dialog!.querySelector<HTMLAnchorElement>('a[aria-label="Download"]')?.getAttribute("href")).toBe(`${content}?download=true`);

    dispose();
    dom.cleanup();
  });
});
