import { describe, expect, jest, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { markdownExtension } from "./markdown";

// Every block opens at the start of the note, where CodeMirror's default selection sits. Nobody is editing it until the
// editor has focus, so readers see it rendered; once focus leaves, the block last edited renders again.
describe("Markdown blocks render while the editor has no focus", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  // `widget` names the rendered element when the rendered text may still read like its source, as math before KaTeX loads.
  const cases: Array<{ name: string; doc: string; source: string; widget?: string; extensions: () => Promise<Extension[]> }> = [
    {
      name: "link",
      doc: "[link](https://example.com) after\n\nEnd",
      source: "](https://example.com)",
      extensions: async () => [(await import("./links")).linksExtension()],
    },
    {
      name: "image",
      doc: "![Harbor](https://example.com/harbor.png)\n\n\nEnd",
      source: "![Harbor]",
      extensions: async () => [(await import("./images")).imageExtension()],
    },
    {
      name: "math",
      doc: "$x^2$ grows\n\nEnd",
      source: "$x^2$",
      widget: ".cm-katex-inline",
      extensions: async () => [(await import("./katex")).katexExtension()],
    },
    {
      name: "table",
      doc: "| Name | Value |\n| --- | --- |\n| a | 1 |\n\nEnd",
      source: "| --- |",
      extensions: async () => [(await import("./tables")).tablesExtension()],
    },
    {
      name: "notice",
      doc: ":::warning\nBack up first.\n:::\n\nEnd",
      source: ":::warning",
      extensions: async () => [(await import("./info-blocks")).infoBlocksExtension("en")],
    },
    {
      name: "Mermaid diagram",
      doc: "```mermaid\nflowchart LR\n  A-->B\n```\n\nEnd",
      source: "```mermaid",
      extensions: async () => [(await import("./mermaid")).mermaidExtension({ configuration: () => ({}), title: () => "Flow" })],
    },
    {
      name: "data block",
      doc: "@numbers\n:::data\nweek: 3\n:::\n\nEnd",
      source: ":::data",
      extensions: async () => [
        (await import("./named-blocks")).namedBlocksExtension(),
        (await import("./data-blocks")).dataBlocksExtension(),
      ],
    },
  ];

  test.each(cases)(
    "a $name at the start renders without focus, shows its source with focus, and renders again on blur",
    async ({ doc, source, widget, extensions }) => {
      const dom = createDomTestHarness();
      const rendered = () =>
        widget ? view.contentDOM.querySelector(widget) !== null : !(view.contentDOM.textContent ?? "").includes(source);
      const view = new EditorView({
        parent: dom.root,
        state: EditorState.create({ doc, extensions: [markdownExtension(), ...(await extensions())] }),
      });
      forceParsing(view, doc.length, 5000);
      view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
      jest.useFakeTimers();
      try {
        expect(view.state.selection.main.head).toBe(0);
        expect(rendered()).toBe(true);

        // CodeMirror reports a focus change after 10 ms.
        view.focus();
        jest.advanceTimersByTime(10);
        expect(rendered()).toBe(false);
        expect(view.contentDOM.textContent).toContain(source);

        view.contentDOM.blur();
        jest.advanceTimersByTime(10);
        expect(rendered()).toBe(true);
      } finally {
        jest.useRealTimers();
        view.destroy();
        dom.cleanup();
      }
    },
  );
});
