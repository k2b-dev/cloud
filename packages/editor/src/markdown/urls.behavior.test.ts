import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { MarkdownUrlOptions } from "./urls";

const mount = async (source: string, options: MarkdownUrlOptions) => {
  const dom = createDomTestHarness();
  const { imageExtension, linksExtension, markdownExtension, refreshMarkdownDecorationsEffect } = await import("./index");
  const doc = `${source}\n\nEnd`;
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownExtension(), imageExtension(options), linksExtension(options)],
    }),
  });
  forceParsing(view, doc.length, 5000);
  view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
  return {
    dom,
    [Symbol.dispose]() {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("host-owned Markdown URLs", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("resolves and opens a reference through the host without moving its selection", async () => {
    const resolved: string[][] = [];
    const opened: string[][] = [];
    using editor = await mount("[Note](note://Ab12Cd#section)", {
      resolveUrl: (kind, ref) => {
        resolved.push([kind, ref]);
        return "/notes/target#section";
      },
      openLink: (url, ref, label) => {
        opened.push([url, ref, label]);
      },
    });
    editor.dom.root.querySelector<HTMLElement>(".k2b-reference")!.click();
    expect(resolved).toContainEqual(["link", "note://Ab12Cd#section"]);
    expect(opened).toEqual([["/notes/target#section", "note://Ab12Cd#section", "Note"]]);
  });

  test("resolves a host-owned scheme before classifying and opening its destination", async () => {
    const opened: string[][] = [];
    using editor = await mount("[Guide](asset://guide)", {
      resolveUrl: (_kind, ref) => (ref === "asset://guide" ? "/files/guide.pdf" : ref),
      openLink: (url, ref, label) => {
        opened.push([url, ref, label]);
      },
    });
    const link = editor.dom.root.querySelector<HTMLElement>(".k2b-reference")!;
    expect(link.dataset.reference).toBe("pdf");
    link.click();
    expect(opened).toEqual([["/files/guide.pdf", "asset://guide", "Guide"]]);
  });

  test("resolves an image and hands pointer and keyboard opening to the host", async () => {
    const opened: string[][] = [];
    using editor = await mount("![Plan](attach://Ab12Cd =400x200)", {
      resolveUrl: (kind, ref) => (kind === "image" && ref === "attach://Ab12Cd" ? "/images/plan.png" : ref),
      openImage: (image, url, label) => {
        opened.push([image.getAttribute("src") ?? "", url, label]);
      },
    });
    const widget = editor.dom.root.querySelector<HTMLElement>(".cm-image-widget")!;
    widget.click();
    widget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(Array.from({ length: 2 }, () => ["/images/plan.png", "/images/plan.png", "Plan"]));
  });

  test("foreign image links never create an image request; same-origin images stay images", async () => {
    using editor = await mount("![Foreign](https://example.test/plan.png)\n\n![Local](/plan.png)", { foreignImagesAsLinks: true });
    const widgets = editor.dom.root.querySelectorAll(".cm-image-widget");
    expect(widgets[0]?.querySelector("img")).toBeNull();
    expect(widgets[0]?.querySelector("a")?.getAttribute("href")).toBe("https://example.test/plan.png");
    expect(widgets[1]?.querySelector("img")?.getAttribute("src")).toBe("/plan.png");
  });

  test("unsafe resolved URLs and unresolved custom schemes stay literal source", async () => {
    using unsafe = await mount("[Note](note://Ab12Cd)\n\n![Plan](attach://Ab12Cd)", { resolveUrl: () => "javascript:alert(1)" });
    expect(unsafe.dom.root.querySelector(".k2b-reference, .cm-image-widget")).toBeNull();
    using unresolved = await mount("[Note](note://Ab12Cd)\n\n![Plan](attach://Ab12Cd)", {});
    expect(unresolved.dom.root.querySelector(".k2b-reference, .cm-image-widget")).toBeNull();
  });
});
