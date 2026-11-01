import { describe, expect, test } from "bun:test";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { DOCUMENTED_IMAGE_FORMS } from "./lib/markdown-image.fixtures";
import { markdownExtension } from "./markdown";

describe("editor images", () => {
  if (isServer) {
    test.skip("editor images run with browser export conditions", () => {});
    return;
  }

  const mount = async (markdown: string, resolveUrl = (_kind: string, ref: string) => ref.replace("attach://", "/images/")) => {
    const dom = createDomTestHarness();
    const { imageExtension } = await import("./images");
    const doc = `${markdown}\n\n\nEnd`;
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdownExtension(), imageExtension({ resolveUrl })],
      }),
    });
    forceParsing(view, doc.length, 5000);
    view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
    return {
      dom,
      view,
      cleanup: () => {
        view.destroy();
        dom.cleanup();
      },
    };
  };

  for (const fixture of DOCUMENTED_IMAGE_FORMS) {
    test(fixture.name, async () => {
      const { dom, view, cleanup } = await mount(fixture.markdown);
      try {
        const images = dom.root.querySelectorAll<HTMLImageElement>(".cm-image-widget img");
        expect(images).toHaveLength(1);
        const img = images[0]!;
        expect(img.getAttribute("src")).toBe(fixture.href.startsWith("attach://") ? "/images/GHI789" : fixture.href);
        expect(img.getAttribute("alt")).toBe(fixture.alt);
        expect(img.getAttribute("title")).toBe(fixture.title);
        expect(img.getAttribute("width")).toBe(fixture.width === null ? null : String(fixture.width));
        expect(img.getAttribute("height")).toBe(fixture.height === null ? null : String(fixture.height));
        // The suffix reserves the place before the image loads and never lets it grow past the column.
        expect(img.style.maxWidth).toBe("100%");
        expect(img.style.height).toBe(fixture.height !== null && fixture.width === null ? `${fixture.height}px` : "auto");
        if (fixture.width !== null || fixture.height !== null) {
          const image = syntaxTree(view.state).topNode.firstChild?.getChild("Image");
          expect(image?.from).toBe(0);
          expect(image?.to).toBe(fixture.markdown.length);
          const url = image?.getChild("URL");
          expect(url && view.state.sliceDoc(url.from, url.to)).toBe(fixture.href);
        }
      } finally {
        cleanup();
      }
    });
  }

  for (const title of ['"Ground floor"', "'Ground floor'", "(Ground floor)"]) {
    test(`a plain image reads its ${title[0]} title from Lezer`, async () => {
      const { dom, cleanup } = await mount(`![Plan](https://example.test/a.png ${title})`);
      try {
        const img = dom.root.querySelector<HTMLImageElement>(".cm-image-widget img")!;
        expect(img.getAttribute("src")).toBe("https://example.test/a.png");
        expect(img.title).toBe("Ground floor");
      } finally {
        cleanup();
      }
    });
  }

  test("an image without a URL child gets no widget", async () => {
    const { dom, cleanup } = await mount("![Plan][ref]");
    try {
      expect(dom.root.querySelector(".cm-image-widget")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a host-resolved blob: image renders, while a blob: URL typed into the text stays source", async () => {
    const local = await mount("![Plan](file:K1)", (_kind, ref) => (ref === "file:K1" ? "blob:http://localhost/1f0e" : ref));
    try {
      expect(local.dom.root.querySelector<HTMLImageElement>(".cm-image-widget img")?.getAttribute("src")).toBe(
        "blob:http://localhost/1f0e",
      );
    } finally {
      local.cleanup();
    }
    const typed = await mount("![Plan](blob:http://localhost/1f0e)");
    try {
      expect(typed.dom.root.querySelector(".cm-image-widget")).toBeNull();
    } finally {
      typed.cleanup();
    }
  });

  test("a title edit updates the image widget", async () => {
    const { dom, view, cleanup } = await mount('![Plan](attach://GHI789 =400x "Before")');
    try {
      expect(dom.root.querySelector<HTMLImageElement>(".cm-image-widget img")?.title).toBe("Before");
      const from = view.state.doc.toString().indexOf("Before");
      view.dispatch({ changes: { from, to: from + "Before".length, insert: "After" } });
      expect(dom.root.querySelector<HTMLImageElement>(".cm-image-widget img")?.title).toBe("After");
    } finally {
      cleanup();
    }
  });
});
