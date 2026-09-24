import { describe, expect, spyOn, test } from "bun:test";
import { files } from "@k2b/stdlib/browser";
import { delegateEvents, isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const figure =
  '<figure class="notebook-book-mermaid"><figcaption>Diagram source</figcaption><pre><code class="language-mermaid">flowchart TD\n A-->B</code></pre></figure>';
const diagramSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 120 60" style="max-width: 120px;"><rect width="120" height="60"/></svg>';
const settle = () => Bun.sleep(20);

const harness = () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "keydown", "pointerdown", "pointermove", "pointerup"], dom.document);
  // The SVG export parses the rendered markup; the shared harness does not expose these globals.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMParser = dom.window.DOMParser;
  globals.XMLSerializer = dom.window.XMLSerializer;
  return {
    ...dom,
    cleanup: () => {
      delete globals.DOMParser;
      delete globals.XMLSerializer;
      dom.cleanup();
    },
  };
};

describe("Book Mermaid enhancement", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("uses an image sink, retains source and revokes URLs on disposal", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    try {
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(
        dom.root,
        async () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        controller.signal,
        "Failed",
      );
      const image = dom.root.querySelector("img")!;
      expect(image.src).toStartWith("blob:");
      expect(dom.root.querySelector("svg")).toBeNull();
      expect(dom.root.querySelector("script")).toBeNull();
      image.dispatchEvent(new Event("load"));
      expect(dom.root.querySelector("details code")?.textContent).toContain("A-->B");
      controller.abort();
      expect(dom.root.querySelector("img")).toBeNull();
      expect(dom.root.querySelector(".k2b-zoom-pan")).toBeNull();
      expect(dom.root.querySelector("details")).toBeNull();
      expect(dom.root.querySelector("pre")?.textContent).toContain("A-->B");
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("the diagram is zoomable and opens fullscreen with a fresh image and exports", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    const downloads: { content: unknown; filename: string; type?: string }[] = [];
    const download = spyOn(files, "downloadFileFromContent").mockImplementation((content, filename, type) => {
      downloads.push({ content, filename, type });
    });
    try {
      dom.root.setAttribute("aria-label", "Release: plan");
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(dom.root, async () => diagramSvg, controller.signal, "Failed");
      const viewport = dom.root.querySelector<HTMLElement>(".k2b-zoom-pan.notebook-book-diagram-view")!;
      expect(viewport.getAttribute("aria-label")).toBe("Diagram");
      expect(viewport.dataset.controls).toBe("visible");
      const inline = viewport.querySelector("img")!;
      expect(inline.alt).toBe("Diagram source");

      viewport.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click();
      expect(viewport.dataset.zoomed).toBe("true");

      viewport.querySelector<HTMLButtonElement>('button[aria-label="Open fullscreen"]')!.click();
      await settle();
      const dialog = dom.document.querySelector("dialog")!;
      expect(dialog.className).toContain("k2b-dialog--full");
      expect(dialog.querySelector("h2")?.textContent).toBe("Release: plan");
      const copy = dialog.querySelector<HTMLImageElement>(".k2b-zoom-pan img")!;
      expect(copy).not.toBe(inline);
      expect(copy.src).toBe(inline.src);
      // Fullscreen always starts at fit.
      expect(dialog.querySelector<HTMLElement>(".k2b-zoom-pan")!.dataset.zoomed).toBeUndefined();

      const svgAction = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button")).find(
        (button) => button.textContent?.trim() === "Download SVG",
      )!;
      svgAction.click();
      for (let waited = 0; waited < 2_000 && downloads.length === 0; waited += 10) await Bun.sleep(10);
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.filename).toBe("Release- plan.svg");
      expect(downloads[0]!.type).toBe("image/svg+xml");
      expect(String(downloads[0]!.content)).toContain('width="120"');
      expect(String(downloads[0]!.content)).toContain('height="60"');
      expect(String(downloads[0]!.content)).not.toContain("max-width");

      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      await settle();
      expect(dom.document.querySelector("dialog")).toBeNull();
    } finally {
      download.mockRestore();
      controller.abort();
      dom.cleanup();
    }
  });

  test("a rejected diagram keeps readable source with localized feedback", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    try {
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(
        dom.root,
        async () => {
          throw new Error("parse error");
        },
        controller.signal,
        "Diagramm nicht verfügbar",
      );
      expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Diagramm nicht verfügbar");
      expect(dom.root.querySelector("pre")?.textContent).toContain("A-->B");
      expect(dom.root.querySelector("img")).toBeNull();
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("an undecodable image removes its viewport and reports the error", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    try {
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(dom.root, async () => diagramSvg, controller.signal, "Failed");
      dom.root.querySelector("img")!.dispatchEvent(new Event("error"));
      expect(dom.root.querySelector(".k2b-zoom-pan")).toBeNull();
      expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Failed");
      expect(dom.root.querySelector("pre")?.textContent).toContain("A-->B");
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("abort prevents late mutation and stops rendering subsequent diagrams", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    let calls = 0;
    try {
      dom.root.innerHTML = figure + figure;
      const pending = enhanceBookMermaid(
        dom.root,
        () => {
          calls++;
          return new Promise<string>((done) => {
            resolve = done;
          });
        },
        controller.signal,
        "Failed",
      );
      controller.abort();
      resolve("<svg/>");
      await pending;
      expect(calls).toBe(1);
      expect(dom.root.querySelector("img")).toBeNull();
      expect(dom.root.querySelectorAll("pre").length).toBe(2);
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("empty roots do no rendering work", async () => {
    const dom = harness();
    const { enhanceBookMermaid } = await import("./book-mermaid");
    const controller = new AbortController();
    let calls = 0;
    try {
      await enhanceBookMermaid(
        dom.root,
        async () => {
          calls++;
          return "<svg/>";
        },
        controller.signal,
        "Failed",
      );
      expect(calls).toBe(0);
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });
});
