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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await settle();
  expect(condition()).toBe(true);
};
const drop = (root: HTMLElement, files: File[]) => {
  const target = root.querySelector(".k2b-app-workspace__main");
  if (!target) throw new Error("Image workspace missing");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, items: files.map((file) => ({ kind: "file", type: file.type })) },
  });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
};
const mockImages = (preview = async () => image.thumbUrl) => [
  spyOn(imageTools, "create").mockResolvedValue({ ...imageData, width: 48, height: 32 }),
  spyOn(imageTools.presets, "thumbnail").mockResolvedValue(image.thumbUrl),
  spyOn(imageTools, "toBase64").mockReturnValue(preview),
];

describe("Image Processor crop drag", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a crop drag holds page text selection until its pointer is released", async () => {
    const dom = createDomTestHarness();
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image], initialCropActive: true }), dom.root);
    try {
      // The mount builds the preview; let it settle while the document still exists.
      while (dom.root.querySelector(".ti-loader-2")) await new Promise((resolve) => setTimeout(resolve, 0));
      const handle = dom.root.querySelector<HTMLElement>(".cursor-nwse-resize");
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

  test("below the desktop width a failed file closes the inspector that would cover the failure notice", async () => {
    const dom = createDomTestHarness();
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    const mocks = [...mockImages(), spyOn(defaultDeps, "decodeNative").mockRejectedValue(new Error("Damaged PNG"))];
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const { AppWorkspace } = await import("@k2b/ui");
    const dispose = render(
      () =>
        createComponent(AppWorkspace, {
          get children() {
            return createComponent(AppWorkspace.Content, {
              get children() {
                return createComponent(ImageProcessorView, { initialImages: [image] });
              },
            });
          },
        }),
      dom.root,
    );
    const inspector = () => dom.root.querySelector("#k2b-workspace-detail-image-processor-inspector");
    try {
      await settle();
      expect(inspector()?.hasAttribute("hidden")).toBe(false);
      drop(dom.root, [new File(["x"], "broken.png", { type: "image/png" })]);
      await waitFor(() => !!dom.root.querySelector('[aria-label="Files that could not be added"]'));
      expect(dom.root.querySelector('[aria-label="Files that could not be added"]')?.textContent).toContain("broken.png");
      expect(inspector()?.hasAttribute("hidden")).toBe(true);
      // The failure stays exposed until the person explicitly requests controls.
      await settle();
      expect(inspector()?.hasAttribute("hidden")).toBe(true);
      const toggle = dom.root.querySelector<HTMLButtonElement>("[data-app-workspace-detail-toggle]")!;
      expect(toggle.disabled).toBe(false);
      toggle.click();
      expect(inspector()?.hasAttribute("hidden")).toBe(false);
      expect(dom.root.querySelector('[aria-label="Files that could not be added"]')?.textContent).toContain("broken.png");
    } finally {
      dispose();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });

  test("files dropped during crop get visible per-file refusals, cleared by the next fresh load", async () => {
    const dom = createDomTestHarness();
    const mocks = [...mockImages(), spyOn(defaultDeps, "decodeNative").mockResolvedValue({ width: 1200, height: 800 })];
    const { ImageProcessorView } = await import("./ImageProcessor.island.tsx");
    const dispose = render(() => createComponent(ImageProcessorView, { initialImages: [image], initialCropActive: true }), dom.root);
    try {
      await settle();
      drop(dom.root, [new File([], "later.png", { type: "image/png" }), new File([], "also-later.png", { type: "image/png" })]);
      const notice = dom.root.querySelector('[aria-label="Files that could not be added"]');
      expect(notice?.closest(".k2b-app-workspace__main")).not.toBeNull();
      expect(notice?.textContent).toContain("later.png");
      expect(notice?.textContent).toContain("also-later.png");
      expect(notice?.querySelectorAll("li")).toHaveLength(2);
      for (const item of notice!.querySelectorAll("li")) {
        expect(item.textContent).toContain("Apply or cancel the crop before adding images");
        // The name line and the reason line; a crop refusal has no extra hint.
        expect(item.querySelectorAll("p")).toHaveLength(2);
        expect(item.querySelector(".text-dimmed")).toBeNull();
      }
      const cancel = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Cancel");
      cancel!.click();
      drop(dom.root, [new File([], "fresh.png", { type: "image/png" })]);
      expect(dom.root.querySelector('[aria-label="Files that could not be added"]')).toBeNull();
      await waitFor(() => !dom.root.querySelector(".ti-loader-2"));
    } finally {
      dispose();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });

  test("queues drops in order, counts queued files, and retains failures only for the running load", async () => {
    const dom = createDomTestHarness();
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
    const notice = () => dom.root.querySelector('[aria-label="Files that could not be added"]');
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
      await waitFor(() => !dom.root.querySelector(".ti-loader-2"));
      expect(Array.from(dom.root.querySelectorAll<HTMLButtonElement>("nav button[title]")).map((button) => button.title)).toEqual([
        "second.png",
        "fourth.png",
      ]);
      drop(dom.root, [files[4]!]);
      expect(notice()).toBeNull();
      gates[4]!.resolve({ width: 1200, height: 800 });
      await waitFor(() => !dom.root.querySelector(".ti-loader-2"));
      expect(started).toEqual(files.map((file) => file.name));
    } finally {
      dispose();
      native.mockRestore();
      for (const mock of mocks) mock.mockRestore();
      dom.cleanup();
    }
  });
});
