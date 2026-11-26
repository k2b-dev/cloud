import { describe, expect, spyOn, test } from "bun:test";
import { type ImgData, images as imageTools } from "@k2b/stdlib/browser";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { defaultDeps } from "./image-intake/intake";
import { DEFAULT_ADJ } from "./image-processor/constants";
import type { ImageEntry } from "./image-processor/types";

const imageData = { width: 1200, height: 800 } as ImgData;
const image: ImageEntry = {
  id: "image-1",
  file: new File(["image"], "invoice.png", { type: "image/png" }),
  source: imageData,
  previewSource: imageData,
  originalSource: imageData,
  originalPreviewSource: imageData,
  thumbUrl: "data:image/png;base64,aW1hZ2U=",
  name: "invoice.png",
  adj: { ...DEFAULT_ADJ },
  markup: [],
  markupUndo: [],
  markupRedo: [],
  cropped: false,
  cropBounds: { x: 0, y: 0, w: 1, h: 1 },
};

/** The DOM of a wide window: v2's dialogs and the stage ask `matchMedia` for the phone layout. */
const harness = () => {
  const dom = createDomTestHarness();
  const media = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: media });
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: media });
  return dom;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await settle();
  expect(condition()).toBe(true);
};
// The page takes dropped images anywhere (v2 has no drop target of its own).
const drop = (root: HTMLElement, files: File[]) => {
  const target = root.ownerDocument.body;
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, items: files.map((file) => ({ kind: "file", type: file.type })) },
  });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
};
const mockImages = (preview = async () => image.thumbUrl) => [
  spyOn(imageTools, "create").mockResolvedValue({ ...imageData, width: 48, height: 32 }),
  spyOn(imageTools, "resize").mockReturnValue(async (data: ImgData | Promise<ImgData>) => data),
  // the stage's preview is a PNG; a thumbnail (JPEG) never waits on it
  spyOn(imageTools, "toBase64").mockImplementation((format) => (format === "png" ? preview : async () => image.thumbUrl)),
];

describe("Image Processor crop drag", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a crop drag holds page text selection until its pointer is released", async () => {
    const dom = harness();
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image], initialCropActive: true }), dom.root);
    try {
      // The mount builds the preview; let it settle while the document still exists.
      while (dom.root.querySelector("[data-stage-busy]")) await new Promise((resolve) => setTimeout(resolve, 0));
      const handle = dom.root.querySelector<HTMLElement>('[data-crop-handle="nw"]');
      if (!handle) throw new Error(dom.root.innerHTML);
      const userSelect = () => document.documentElement.style.getPropertyValue("user-select");
      const win = dom.window as unknown as { PointerEvent: typeof PointerEvent };
      const pointer = (type: string, init: PointerEventInit = {}) =>
        handle.dispatchEvent(
          new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: "mouse", isPrimary: true, ...init }),
        );

      pointer("pointerdown", { button: 2, buttons: 2 });
      expect(userSelect()).toBe("");
      pointer("pointerup", { button: 2 });

      pointer("pointerdown", { button: 0, buttons: 1 });
      expect(userSelect()).toBe("none");
      pointer("pointerup", { button: 0 });
      expect(userSelect()).toBe("");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("the header's more menu still removes the active image", async () => {
    const dom = harness();
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const second: ImageEntry = { ...image, id: "image-2", name: "receipt.png" };
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image, second] }), dom.root);
    // the last step of the head's path names the open photo
    const title = () => dom.root.querySelector('[data-k2-part="Path"] [aria-current="page"]')?.textContent;
    try {
      while (dom.root.querySelector("[data-stage-busy]")) await settle();
      expect(title()).toBe("invoice.png");
      const more = dom.root.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]');
      if (!more) throw new Error("The head has no more menu");
      more.click();
      await settle();
      const remove = Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent?.trim() === "Remove image",
      );
      if (!remove) throw new Error("Remove image is missing from the more menu");
      expect(remove.getAttribute("aria-disabled")).not.toBe("true");
      remove.click();
      await waitFor(() => title() === "receipt.png");
      // Let the preview of the next image finish building while the document still exists.
      await settle();
      while (dom.root.querySelector("[data-stage-busy]")) await settle();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("a file that fails beside an open photo says why in the inspector, and can be hidden", async () => {
    const dom = harness();
    const mocks = [...mockImages(), spyOn(defaultDeps, "decodeNative").mockRejectedValue(new Error("Damaged PNG"))];
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image] }), dom.root);
    const notices = () => Array.from(dom.root.querySelectorAll('[data-k2-part="Notice"]'));
    try {
      await settle();
      drop(dom.root, [new File(["x"], "broken.png", { type: "image/png" })]);
      await waitFor(() => notices().some((notice) => notice.textContent?.includes("broken.png")));
      const notice = notices().find((each) => each.textContent?.includes("broken.png"))!;
      expect(notice.closest('[aria-label="Image controls"]')).not.toBeNull();
      expect(notice.textContent).toContain("This image could not be read.");
      Array.from(notice.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Hide broken.png"))!
        .click();
      await settle();
      expect(notices().some((each) => each.textContent?.includes("broken.png"))).toBe(false);
      await waitFor(() => !dom.root.querySelector("[data-stage-busy]"));
    } finally {
      dispose();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });

  test("files dropped during crop get visible per-file refusals, cleared by the next fresh load", async () => {
    const dom = harness();
    const mocks = [...mockImages(), spyOn(defaultDeps, "decodeNative").mockResolvedValue({ width: 1200, height: 800 })];
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image], initialCropActive: true }), dom.root);
    try {
      await settle();
      drop(dom.root, [new File([], "later.png", { type: "image/png" }), new File([], "also-later.png", { type: "image/png" })]);
      // one notice per refused file, each with its name and what to do
      const notices = Array.from(dom.root.querySelectorAll('[data-k2-part="Notice"]'));
      expect(notices).toHaveLength(2);
      expect(notices[0]!.textContent).toContain("later.png: Apply or cancel the crop before adding images");
      expect(notices[1]!.textContent).toContain("also-later.png: Apply or cancel the crop before adding images");
      const cancel = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Cancel");
      cancel!.click();
      drop(dom.root, [new File([], "fresh.png", { type: "image/png" })]);
      expect(dom.root.querySelector('[data-k2-part="Notice"]')).toBeNull();
      await waitFor(() => !dom.root.querySelector("[data-stage-busy]"));
    } finally {
      dispose();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });

  test("queues drops in order, counts queued files, and retains failures only for the running load", async () => {
    const dom = harness();
    const files = ["first.png", "second.png", "third.png", "fourth.png", "fresh.png"].map(
      (name) => new File([], name, { type: "image/png" }),
    );
    const gates = files.map(() => Promise.withResolvers<{ width: number; height: number }>());
    const started: string[] = [];
    const preview = Promise.withResolvers<string>();
    let previewStarted = false;
    const mocks = mockImages(async () => {
      if (previewStarted) return image.thumbUrl;
      previewStarted = true;
      return preview.promise;
    });
    const native = spyOn(defaultDeps, "decodeNative").mockImplementation((source) => {
      const index = files.findIndex((file) => file === source);
      if (index < 0) throw new Error("Unexpected source");
      started.push(files[index]!.name);
      return gates[index]!.promise;
    });
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(
      () =>
        createComponent(ImageProcessorView, {
          initialLoadFailures: [{ file: new File([], "old.heic"), reason: "decode-failed" as const }],
        }),
      dom.root,
    );
    const notice = () => {
      const all = Array.from(dom.root.querySelectorAll('[data-k2-part="Notice"]'));
      return all.length ? { textContent: all.map((each) => each.textContent).join(" ") } : null;
    };
    try {
      await settle();
      drop(dom.root, files.slice(0, 2));
      expect(notice()).toBeNull();
      expect(started).toEqual(["first.png"]);
      expect(dom.root.textContent).toContain("first.png (1 of 2)");
      gates[0]!.reject(new Error("Damaged PNG"));
      await waitFor(() => started.length === 2);
      expect(notice()?.textContent).toContain("first.png");
      drop(dom.root, [files[2]!]);
      expect(started).toEqual(["first.png", "second.png"]);
      expect(dom.root.textContent).toContain("second.png (2 of 3)");
      expect(notice()?.textContent).toContain("first.png");
      gates[1]!.resolve({ width: 1200, height: 800 });
      await waitFor(() => started.length === 3);
      expect(dom.root.textContent).toContain("third.png (3 of 3)");
      gates[2]!.reject(new Error("Damaged PNG"));
      await waitFor(() => previewStarted);
      // A drop while the last preview is being built must also stay in the queue.
      drop(dom.root, [files[3]!]);
      expect(dom.root.textContent).toContain("third.png (3 of 4)");
      expect(notice()?.textContent).toContain("first.png");
      expect(notice()?.textContent).toContain("third.png");
      preview.resolve(image.thumbUrl);
      await waitFor(() => started.length === 4);
      gates[3]!.resolve({ width: 1200, height: 800 });
      await waitFor(() => !dom.root.querySelector("[data-stage-busy]"));
      expect(
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>('nav[aria-label="Images"] button[aria-label^="Open"]')).map(
          (button) => button.title,
        ),
      ).toEqual(["second.png", "fourth.png"]);
      drop(dom.root, [files[4]!]);
      expect(notice()).toBeNull();
      gates[4]!.resolve({ width: 1200, height: 800 });
      await waitFor(() => !dom.root.querySelector("[data-stage-busy]"));
      expect(started).toEqual(files.map((file) => file.name));
    } finally {
      dispose();
      native.mockRestore();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });
});
