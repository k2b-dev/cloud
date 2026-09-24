import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { applyLigatures, ligaturesExtension } from "./ligatures";
import { markdownExtension } from "./markdown";
import { customLightInit } from "./theme";

const mount = (doc: string, anchor = doc.length) => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [markdownExtension(), ligaturesExtension()] }),
  });
  // Exclusions follow the syntax tree; finish the parse like the editor does after mount.
  forceParsing(view, doc.length, 5000);
  view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
  const symbols = () => Array.from(dom.root.querySelectorAll(".cm-ligature")).map((node) => node.textContent);
  return {
    view,
    symbols,
    [Symbol.dispose]: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("editor display ligatures", () => {
  if (isServer) {
    test.skip("editor ligatures run with browser export conditions", () => {});
    return;
  }

  test("prose shows symbols while the document keeps the typed characters", () => {
    const doc = "Plan: a -> b <=> c, x != y, (c) 2026\n";
    using editor = mount(doc);
    expect(editor.symbols()).toEqual(["→", "⇔", "≠", "©"]);
    expect(editor.view.state.doc.toString()).toBe(doc);
    expect(editor.view.contentDOM.textContent).toContain("a → b ⇔ c");
  });

  test("heading and emphasis styling wraps the symbol", () => {
    const dom = createDomTestHarness();
    const doc = "# Plan -> done\n\nsome *a -> b* text";
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc, extensions: [markdownExtension(), customLightInit(), ligaturesExtension()] }),
    });
    try {
      forceParsing(view, doc.length, 5000);
      view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
      const ligatures = Array.from(dom.root.querySelectorAll(".cm-ligature"));
      expect(ligatures).toHaveLength(2);
      // Highlighting classes sit on the wrapping span, the same one that styles the text around the symbol.
      for (const ligature of ligatures) expect(ligature.parentElement?.classList.contains("cm-line")).toBe(false);
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });

  test("a cursor or selection touching a sequence reveals its characters", () => {
    const doc = "a -> b and c => d";
    using editor = mount(doc, doc.indexOf("->") + 1);
    expect(editor.symbols()).toEqual(["⇒"]);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("=>") } });
    expect(editor.symbols()).toEqual(["→"]);
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.symbols()).toEqual(["→", "⇒"]);
    editor.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(editor.symbols()).toEqual([]);
  });

  test("code, math, links, HTML, front matter, notebook blocks and table rules stay literal", () => {
    const doc = [
      "---",
      "title: a -> b",
      "---",
      "",
      "Inline `a -> b` and $x -> y$ and [a -> b](https://x.test/a->b) and https://x.test/c->d",
      "",
      "<!-- a -> b -->",
      "",
      "```",
      "a -> b",
      "```",
      "",
      "```mermaid",
      "graph LR; A --> B",
      "```",
      "",
      "$$",
      "x <= y",
      "$$",
      "",
      ":::query",
      "where x >= 1",
      ":::",
      "",
      ":::data",
      "range: 1 -> 2",
      ":::",
      "",
      "| a | b |",
      "| -- | -- |",
      "| 1 | 2 |",
      "",
      "Only this -> one.",
    ].join("\n");
    using editor = mount(doc);
    expect(editor.symbols()).toEqual(["→"]);
    expect(editor.view.state.doc.toString()).toBe(doc);
  });

  test("widget prose gets the same symbols, code inside it does not", () => {
    const dom = createDomTestHarness();
    try {
      dom.root.innerHTML = "<p>a -> b <code>c -> d</code> <a href='#'>e -> f</a></p>";
      applyLigatures(dom.root);
      expect(Array.from(dom.root.querySelectorAll(".cm-ligature")).map((node) => [node.textContent, node.getAttribute("title")])).toEqual([
        ["→", "->"],
      ]);
      expect(dom.root.querySelector("code")?.textContent).toBe("c -> d");
    } finally {
      dom.cleanup();
    }
  });
});
