import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { codeFenceCompletionSource } from "./code-fence-snippets";
import { codeFontExtension } from "./code-font";
import { markdownExtension } from "./markdown";

describe("inert notebook code", () => {
  test("fence picker offers diagrams, math and standard languages, not executable scripts", () => {
    const state = EditorState.create({ doc: "```", extensions: [markdownExtension()] });
    const result = codeFenceCompletionSource(new CompletionContext(state, 3, true));
    const labels = result?.options.map((option) => option.label);
    expect(labels).not.toContain("script");
    expect(labels).toContain("javascript");
    expect(labels).toContain("mermaid");
    expect(labels).toContain("math");
  });

  if (isServer) {
    test.skip("code rendering runs with browser export conditions", () => {});
    return;
  }

  for (const readOnly of [false, true]) {
    test(`legacy script fences remain visible inert code in ${readOnly ? "readonly" : "write"}`, async () => {
      const dom = createDomTestHarness();
      const markdown = '```script\ndocument.body.dataset.scriptExecuted = "yes";\n```';
      const view = new EditorView({
        parent: dom.root,
        state: EditorState.create({
          doc: markdown,
          extensions: [markdownExtension(), codeFontExtension(), EditorState.readOnly.of(readOnly)],
        }),
      });
      try {
        await Bun.sleep(20);
        expect(view.state.doc.toString()).toBe(markdown);
        expect(dom.root.textContent).toContain('document.body.dataset.scriptExecuted = "yes";');
        expect(dom.root.querySelector(".cm-md-code")).not.toBeNull();
        expect(document.body.dataset.scriptExecuted).toBeUndefined();
        expect(dom.root.querySelector(".md-script-output")).toBeNull();
      } finally {
        view.destroy();
        dom.cleanup();
      }
    });
  }
});
