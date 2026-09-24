import { describe, expect, mock, spyOn, test } from "bun:test";
import { delegateEvents, isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

// happy-dom has no layout for Mermaid; the widget only needs rendered markup.
const renders: { id: string; code: string; htmlLabels: unknown }[] = [];
let htmlLabels: unknown;
mock.module("mermaid", () => ({
  default: {
    initialize: (config: { htmlLabels?: unknown }) => {
      htmlLabels = config.htmlLabels;
    },
    render: async (id: string, code: string) => {
      renders.push({ id, code, htmlLabels });
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" data-render="${renders.length}"><text>${code}</text></svg>`,
      };
    },
  },
}));

const doc = "# Flow\n\nIntro\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\nOutro";
/** Waits for the widget's 500 ms debounced render, polling so a slow runner does not flake. */
const waitForDiagram = async (root: ParentNode) => {
  for (let waited = 0; waited < 3_000; waited += 20) {
    if (root.querySelector(".cm-mermaid-widget .k2b-zoom-pan svg")) return;
    await Bun.sleep(20);
  }
  throw new Error("Mermaid widget did not render");
};

describe("Mermaid editor widget", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (code = "flowchart LR\n  A-->B") => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "keydown", "pointerdown", "pointermove", "pointerup"], dom.document);
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { markdownExtension } = await import("./markdown");
    const { mermaidExtension } = await import("./mermaid");
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc: doc.replace("flowchart LR\n  A-->B", code),
        selection: { anchor: 0 },
        extensions: [markdownExtension(), mermaidExtension()],
      }),
    });
    return { dom, view };
  };

  test("renders a zoomable diagram with hover controls and disposes it with the widget", async () => {
    const { dom, view } = await mount("flowchart LR\n  C-->D");
    try {
      const widget = () => dom.root.querySelector<HTMLElement>(".cm-mermaid-widget");
      expect(widget()?.textContent).toContain("Loading diagram");
      await waitForDiagram(dom.root);
      const viewport = widget()!.querySelector<HTMLElement>(".k2b-zoom-pan")!;
      expect(viewport.dataset.controls).toBe("hover");
      expect(viewport.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 80 40");
      expect(viewport.querySelector('button[aria-label="Open fullscreen"]')).not.toBeNull();

      view.destroy();
      // The Solid root is gone with the widget: no stray viewport keeps listening.
      expect(dom.document.querySelector(".k2b-zoom-pan")).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test("a widget destroyed before its debounce never renders", async () => {
    const before = renders.length;
    const { dom, view } = await mount("flowchart LR\n  E-->F");
    view.destroy();
    await Bun.sleep(600);
    expect(renders.length).toBe(before);
    dom.cleanup();
  });

  test("a press edits at fit; zoomed in, only a click without dragging edits", async () => {
    const { dom, view } = await mount();
    try {
      await waitForDiagram(dom.root);
      const press = (target: Element) =>
        target.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
      const block = doc.indexOf("```mermaid");

      let widget = dom.root.querySelector<HTMLElement>(".cm-mermaid-widget")!;
      // The zoom controls never enter edit mode.
      const zoomIn = widget.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
      press(zoomIn);
      zoomIn.click();
      expect(view.state.selection.main.head).toBe(0);
      const viewport = widget.querySelector<HTMLElement>(".k2b-zoom-pan")!;
      expect(viewport.dataset.zoomed).toBe("true");

      press(viewport.querySelector("svg")!);
      expect(view.state.selection.main.head).toBe(0);
      viewport.querySelector("svg")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }) as unknown as Event);
      expect(view.state.selection.main.head).toBe(block);

      // Leave the block again; the re-created widget starts at fit and edits on press.
      view.dispatch({ selection: { anchor: 0 } });
      await Bun.sleep(20);
      widget = dom.root.querySelector<HTMLElement>(".cm-mermaid-widget")!;
      expect(widget.querySelector(".k2b-zoom-pan")?.hasAttribute("data-zoomed")).toBe(false);
      press(widget.querySelector("svg")!);
      expect(view.state.selection.main.head).toBe(block);
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });

  test("exports render SVG text labels and restore the preview config", async () => {
    const { dom, view } = await mount("flowchart LR\n  G-->H");
    try {
      await waitForDiagram(dom.root);
      const { files } = await import("@k2b/stdlib/browser");
      const saved: string[] = [];
      const download = spyOn(files, "downloadFileFromContent").mockImplementation((_content, filename) => void saved.push(filename));
      const globals = globalThis as unknown as Record<string, unknown>;
      globals.DOMParser = dom.window.DOMParser;
      globals.XMLSerializer = dom.window.XMLSerializer;
      try {
        dom.root.querySelector<HTMLButtonElement>('button[aria-label="Open fullscreen"]')!.click();
        await Bun.sleep(20);
        const dialog = dom.document.querySelector("dialog")!;
        expect(dialog.querySelector("h2")?.textContent).toBe("Flow");
        expect(dialog.querySelector(".k2b-zoom-pan svg")).not.toBeNull();
        const svgAction = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button")).find(
          (button) => button.textContent?.trim() === "Download SVG",
        )!;
        svgAction.click();
        for (let waited = 0; waited < 2_000 && saved.length === 0; waited += 10) await Bun.sleep(10);
        expect(saved).toEqual(["Flow.svg"]);
        const exported = renders.at(-1)!;
        expect(exported.code).toBe("flowchart LR\n  G-->H");
        expect(exported.htmlLabels).toBe(false);
        expect(htmlLabels).toBeUndefined();
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        await Bun.sleep(20);
      } finally {
        download.mockRestore();
        delete globals.DOMParser;
        delete globals.XMLSerializer;
      }
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
