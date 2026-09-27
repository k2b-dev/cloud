import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { FileTreeActions } from "../src/content/FileTree";
import type { FileTreeEntry } from "../src/content/file-tree";
import type { LightboxImage } from "../src/content/Lightbox";
import { createDomTestHarness } from "./dom";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((done) => requestAnimationFrame(() => done()));
};

const key = (element: Element, value: string, options: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value, ...options });
  const handler = (element as Element & { $$keydown?: (event: KeyboardEvent) => void }).$$keydown;
  if (handler) {
    Object.defineProperties(event, {
      currentTarget: { configurable: true, value: element },
      target: { configurable: true, value: element },
    });
    handler(event);
  } else element.dispatchEvent(event);
  return event;
};

describe("@k2b/ui files and media runtime behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps a real roving FileTree focus model stable across refetch and rename", async () => {
    const dom = createDomTestHarness();
    const previousDomRect = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
    Object.defineProperty(globalThis, "DOMRect", { configurable: true, writable: true, value: dom.window.DOMRect });
    const { default: FileTree } = await import("../src/content/FileTree");
    let setEntries: (entries: FileTreeEntry[]) => void = () => {};
    let setActions: (actions: FileTreeActions) => void = () => {};
    const renameCalls: Array<[string, string]> = [];

    const dispose = render(() => {
      const [entries, updateEntries] = createSignal<FileTreeEntry[]>([
        { path: "/src/app.ts", size: 4 },
        { path: "/src/lib.ts", size: 5 },
        { path: "/README.md", size: 10 },
      ]);
      const rename = async (path: string, nextName: string) => {
        renameCalls.push([path, nextName]);
        updateEntries((current) =>
          current.map((entry) =>
            entry.path === path ? { ...entry, path: `${path.slice(0, path.lastIndexOf("/") + 1)}${nextName}` } : { ...entry },
          ),
        );
      };
      const [actions, updateActions] = createSignal<FileTreeActions>({ rename });
      setEntries = updateEntries;
      setActions = updateActions;
      return createComponent(FileTree, {
        get entries() {
          return entries();
        },
        selectedPath: "/src",
        get actions() {
          return actions();
        },
      });
    }, dom.root);
    await flush();

    const tree = dom.root.querySelector<HTMLUListElement>('[role="tree"]')!;
    const rows = () => Array.from(tree.querySelectorAll<HTMLLIElement>(':scope > [role="treeitem"]'));
    const row = (path: string) =>
      rows().find((candidate) => candidate.querySelector<HTMLButtonElement>(".k2b-content-file-tree__select")?.title === path);

    expect(tree.hasAttribute("tabindex")).toBe(false);
    expect(rows().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(row("/src")?.tabIndex).toBe(0);
    expect(row("/src")?.getAttribute("aria-selected")).toBe("true");
    expect(row("/src")?.getAttribute("aria-level")).toBe("1");
    expect(row("/src/app.ts")?.getAttribute("aria-level")).toBe("2");
    expect(tree.querySelector("[role='group']")).toBeNull();
    expect(tree.querySelector<HTMLButtonElement>(".k2b-content-file-tree__actions")?.tabIndex).toBe(-1);
    expect(tree.parentElement?.getAttribute("role")).toBe("group");
    expect(tree.parentElement?.tabIndex).toBe(-1);

    row("/src")?.focus();
    key(row("/src")!, "ArrowDown");
    expect(dom.document.activeElement?.querySelector<HTMLButtonElement>(".k2b-content-file-tree__select")?.title).toBe("/src/app.ts");
    expect(row("/src/app.ts")?.tabIndex).toBe(0);
    expect(row("/src")?.tabIndex).toBe(-1);

    const stableRows = new Map(
      rows().map((item) => [item.querySelector<HTMLButtonElement>(".k2b-content-file-tree__select")?.title, item]),
    );
    setEntries([
      { path: "/src/app.ts", size: 40, updatedAt: "2026-07-29T10:00:00Z", badge: "fresh" },
      { path: "/src/lib.ts", size: 5 },
      { path: "/README.md", size: 10 },
    ]);
    expect(row("/src")).toBe(stableRows.get("/src"));
    expect(row("/src/app.ts")).toBe(stableRows.get("/src/app.ts"));
    expect(row("/src/app.ts")?.textContent).toContain("fresh");
    expect(dom.document.activeElement).toBe(row("/src/app.ts") ?? null);

    key(row("/src/app.ts")!, "F2");
    await flush();
    const input = tree.querySelector<HTMLInputElement>(".k2b-content-file-tree__rename")!;
    expect(dom.document.activeElement).toBe(input);
    input.value = "mai";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    setEntries([
      { path: "/src/app.ts", size: 41, updatedAt: "2026-07-29T11:00:00Z", badge: "newer" },
      { path: "/src/lib.ts", size: 5 },
      { path: "/README.md", size: 10 },
    ]);
    expect(tree.querySelector(".k2b-content-file-tree__rename")).toBe(input);
    expect(dom.document.activeElement).toBe(input);
    expect(input.value).toBe("mai");

    input.value = "main.ts";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    key(input, "Enter");
    await flush();
    expect(renameCalls).toEqual([["/src/app.ts", "main.ts"]]);
    expect(dom.document.activeElement).toBe(row("/src/main.ts") ?? null);
    expect(row("/src/main.ts")?.tabIndex).toBe(0);

    expect(row("/src/main.ts")?.textContent).toContain("Rename");
    setActions({ remove: () => {} });
    expect(row("/src/main.ts")?.textContent).toContain("Delete");
    expect(row("/src/main.ts")?.textContent).not.toContain("Rename");

    row("/src/main.ts")?.focus();
    const rowContextMenu = (row("/src/main.ts") as HTMLLIElement & { $$contextmenu?: (event: MouseEvent) => void }).$$contextmenu;
    rowContextMenu?.(new MouseEvent("contextmenu", { clientX: 20, clientY: 20 }));
    const host = tree.parentElement as HTMLElement & { $$contextmenu?: (event: MouseEvent) => void };
    host.$$contextmenu?.(new MouseEvent("contextmenu", { clientX: 20, clientY: 20 }));
    await flush();
    expect(dom.document.querySelector(".k2b-context-menu")?.textContent).toContain("Delete");
    expect(host.getAttribute("tabindex")).toBe("-1");

    dispose();
    if (previousDomRect) Object.defineProperty(globalThis, "DOMRect", previousDomRect);
    else Reflect.deleteProperty(globalThis, "DOMRect");
    dom.cleanup();
  });

  test("keeps FileView wrapper geometry separate from editor ownership", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");

    const dispose = render(
      () =>
        createComponent(FileView, {
          file: { path: "/src/app.ts", mediaType: "text/plain" },
          load: async () => ({ encoding: "utf8" as const, mediaType: "text/plain", content: "const answer = 42;" }),
          save: async () => {},
        }),
      dom.root,
    );
    await flush();

    const wrapper = dom.root.querySelector<HTMLElement>(".k2b-content-file-view__editor");
    const editor = wrapper?.querySelector<HTMLElement>(":scope > .k2b-markdown-editor");
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toBe(editor);
    expect(wrapper?.classList.contains("k2b-markdown-editor")).toBe(false);
    expect(editor?.getAttribute("data-fill")).toBe("true");

    const contentStyles = readFileSync(resolve(import.meta.dir, "../src/styles/content-parity.css"), "utf8");
    const editorStyles = readFileSync(resolve(import.meta.dir, "../src/styles/editors-parity.css"), "utf8");
    expect(contentStyles).not.toContain(".k2b-content-file-view__editor > .k2b-field");
    expect(editorStyles).not.toContain("k2b-content-file-view__editor");

    dispose();
    dom.cleanup();
  });

  test("refetches FileView content when its host revision changes", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");
    const [revision, setRevision] = createSignal(1);
    let loads = 0;
    const dispose = render(
      () =>
        createComponent(FileView, {
          file: { path: "/README.txt", mediaType: "text/plain" },
          get revision() {
            return revision();
          },
          load: async () => ({ encoding: "utf8" as const, mediaType: "text/plain", content: `load ${++loads}` }),
        }),
      dom.root,
    );

    await flush();
    expect(loads).toBe(1);
    setRevision(2);
    await flush();
    expect(loads).toBe(2);

    dispose();
    dom.cleanup();
  });

  test("reports FileView edits as dirty until the current draft is saved", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");
    const dirtyStates: boolean[] = [];
    const saved: string[] = [];
    const dispose = render(
      () =>
        createComponent(FileView, {
          file: { path: "/notes.txt", mediaType: "text/plain" },
          load: async () => ({ encoding: "utf8" as const, mediaType: "text/plain", content: "Original" }),
          save: async (content) => {
            saved.push(content);
          },
          onDirtyChange: (dirty) => dirtyStates.push(dirty),
        }),
      dom.root,
    );

    await flush();
    const input = dom.root.querySelector<HTMLTextAreaElement>(".k2b-content-file-view__code-input")!;
    input.value = "Changed";
    const inputEvent = new Event("input", { bubbles: true });
    Object.defineProperty(inputEvent, "currentTarget", { configurable: true, value: input });
    (input as HTMLTextAreaElement & { $$input?: (event: Event) => void }).$$input?.(inputEvent);
    await flush();
    expect(dirtyStates.at(-1)).toBe(true);

    const saveButton = dom.root.querySelector<HTMLButtonElement>('[aria-label^="Save"]')!;
    const clickEvent = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(clickEvent, "currentTarget", { configurable: true, value: saveButton });
    (saveButton as HTMLButtonElement & { $$click?: (event: MouseEvent) => void }).$$click?.(clickEvent);
    await flush();
    expect(saved).toEqual(["Changed"]);
    expect(dirtyStates.at(-1)).toBe(false);

    dispose();
    dom.cleanup();
  });

  for (const downloadHref of ["/api/files/content?path=%2Freports%2Fq3.pdf", undefined]) {
    test(`previews a PDF from its loaded bytes and remounts only for changed bytes (downloadHref ${downloadHref ? "set" : "absent"})`, async () => {
      const dom = createDomTestHarness();
      const { default: FileView } = await import("../src/content/FileView");
      const created: Blob[] = [];
      const revoked: string[] = [];
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      URL.createObjectURL = (blob) => {
        created.push(blob as Blob);
        return `blob:pdf-${created.length}`;
      };
      URL.revokeObjectURL = (url) => revoked.push(url);
      const [revision, setRevision] = createSignal(1);
      // The second refetch returns the same bytes, as a host revision bump often does.
      const versions = ["%PDF-1.7 v1", "%PDF-1.7 v1", "%PDF-1.7 v2"];
      let loads = 0;

      try {
        const dispose = render(
          () =>
            createComponent(FileView, {
              file: { path: "/reports/q3.pdf" },
              get revision() {
                return revision();
              },
              load: async () => ({ encoding: "base64" as const, mediaType: "application/pdf", content: btoa(versions[loads++]!) }),
              downloadHref,
            }),
          dom.root,
        );
        await flush();

        expect(loads).toBe(1);
        expect(dom.root.querySelector("object")).toBeNull();
        expect(dom.root.querySelector("iframe")?.getAttribute("src")).toBe("blob:pdf-1");
        expect(created[0]?.type).toBe("application/pdf");
        expect(await created[0]?.text()).toBe("%PDF-1.7 v1");
        const frame = dom.root.querySelector("iframe");

        setRevision(2);
        await flush();
        expect(loads).toBe(2);
        expect(dom.root.querySelector("iframe")).toBe(frame);
        expect(created).toHaveLength(1);
        expect(revoked).toEqual([]);

        setRevision(3);
        await flush();
        expect(loads).toBe(3);
        expect(dom.root.querySelector("iframe")?.getAttribute("src")).toBe("blob:pdf-2");
        expect(await created[1]?.text()).toBe("%PDF-1.7 v2");
        expect(revoked).toEqual(["blob:pdf-1"]);

        dispose();
        expect(revoked).toEqual(["blob:pdf-1", "blob:pdf-2"]);
      } finally {
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
        dom.cleanup();
      }
    });
  }

  test("keeps a host inline PDF URL on the native object without loading bytes", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");
    let loads = 0;
    const dispose = render(
      () =>
        createComponent(FileView, {
          file: { path: "/invoice.pdf", mediaType: "application/pdf" },
          load: async () => {
            loads++;
            return { encoding: "base64" as const, mediaType: "application/pdf", content: "" };
          },
          previewHref: "/inline/invoice.pdf",
          downloadHref: "/download/invoice.pdf",
        }),
      dom.root,
    );
    await flush();

    expect(loads).toBe(0);
    expect(dom.root.querySelector("object")?.getAttribute("data")).toBe("/inline/invoice.pdf?preview-revision=0");
    expect(dom.root.querySelector("iframe")).toBeNull();

    dispose();
    dom.cleanup();
  });

  test("revokes a PDF object URL produced after the preview was disposed", async () => {
    const dom = createDomTestHarness();
    const { default: PdfPreview } = await import("../src/content/PdfPreview");
    let resolveRequest!: (value: Blob) => void;
    const request = new Promise<Blob>((resolve) => {
      resolveRequest = resolve;
    });
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const value = `blob:test-${created.length + 1}`;
      created.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => revoked.push(value);

    try {
      const dispose = render(() => createComponent(PdfPreview, { request: () => request }), dom.root);
      // Call Solid's delegated handler directly: FileView tests above loaded PdfPreview against an earlier document.
      const button = dom.root.querySelector<HTMLButtonElement & { $$click?: (event: MouseEvent) => void }>(
        ".k2b-content-pdf-preview__actions button:last-child",
      );
      button?.$$click?.(new MouseEvent("click"));
      dispose();
      resolveRequest(new Blob([], { type: "application/pdf" }));
      await flush();

      expect(created).toEqual(["blob:test-1"]);
      expect(revoked).toEqual(["blob:test-1"]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      dom.cleanup();
    }
  });

  test("uses simple Lightbox navigation buttons and resyncs a reactive image index", async () => {
    const dom = createDomTestHarness();
    const dialogPrototype = dom.window.HTMLDialogElement.prototype as typeof dom.window.HTMLDialogElement.prototype & {
      showModal: () => void;
      close: () => void;
    };
    dialogPrototype.showModal = function () {
      this.setAttribute("open", "");
    };
    dialogPrototype.close = function () {
      this.removeAttribute("open");
    };
    const { default: Lightbox } = await import("../src/content/Lightbox");
    let setImages: (images: LightboxImage[]) => void = () => {};
    let setInitialIndex: (index: number | undefined) => void = () => {};
    const first = { src: "/a.png", alt: "A" };
    const second = { src: "/b.png", alt: "B" };
    const third = { src: "/c.png", alt: "C" };

    const dispose = render(() => {
      const [images, updateImages] = createSignal<LightboxImage[]>([first, second, third]);
      const [initialIndex, updateInitialIndex] = createSignal<number | undefined>(1);
      setImages = updateImages;
      setInitialIndex = updateInitialIndex;
      return createComponent(Lightbox, {
        get images() {
          return images();
        },
        get initialIndex() {
          return initialIndex();
        },
        onClose: () => {},
      });
    }, dom.root);
    await flush();

    const image = () => dom.root.querySelector<HTMLImageElement>(".k2b-content-lightbox__image");
    expect(image()?.src).toEndWith("/b.png");
    expect(dom.root.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
    expect(dom.root.querySelector(".k2b-content-lightbox__dots")?.getAttribute("role")).toBe("group");
    expect(dom.root.querySelectorAll(".k2b-content-lightbox__dot[aria-current='true']")).toHaveLength(1);

    setImages([third, first, second]);
    expect(image()?.src).toEndWith("/b.png");
    expect(dom.root.querySelector(".k2b-content-lightbox__counter")?.textContent?.trim()).toBe("3 / 3");

    setImages([third]);
    expect(image()?.src).toEndWith("/c.png");
    expect(dom.root.querySelector(".k2b-content-lightbox__counter")).toBeNull();

    setImages([first, second, third]);
    setInitialIndex(99);
    expect(image()?.src).toEndWith("/c.png");
    setInitialIndex(-5);
    expect(image()?.src).toEndWith("/a.png");

    dispose();
    dom.cleanup();
  });

  test("publishes an image transform atomically after it completes", async () => {
    const dom = createDomTestHarness();
    const { ImageInput } = await import("../src/inputs/FileInputs");
    const changes: Array<string | null> = [];
    const commits: Array<string | null> = [];
    let resolveTransform!: (value: string) => void;
    const transformed = new Promise<string>((resolve) => {
      resolveTransform = resolve;
    });
    const dispose = render(
      () =>
        createComponent(ImageInput, {
          label: "Avatar",
          value: null,
          transform: () => transformed,
          onValueChange: (value) => changes.push(value),
          onValueCommit: (value) => commits.push(value),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new dom.window.File(["image"], "avatar.svg", { type: "image/svg+xml" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).toEqual([]);
    expect(commits).toEqual([]);

    resolveTransform("data:image/webp;base64,done");
    await flush();
    expect(changes).toEqual(["data:image/webp;base64,done"]);
    expect(commits).toEqual(["data:image/webp;base64,done"]);

    dispose();
    dom.cleanup();
  });
});
