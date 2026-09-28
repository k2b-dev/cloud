import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { markdownExtension } from "./markdown";
import { tabIndentExtension } from "./tab-indent";

type Mount = { selection: number | { anchor: number; head: number }; tabIndents?: boolean; extensions?: Extension[] };

const mount = (doc: string, { selection, tabIndents = true, extensions = [] }: Mount) => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: typeof selection === "number" ? { anchor: selection } : selection,
      // The note editor leaves the Tab keymap out when the person prefers Tab for focus movement.
      extensions: [markdownExtension(), tabIndents ? tabIndentExtension() : [], ...extensions],
    }),
  });
  forceParsing(view, doc.length, 5000);
  /** Dispatches a real keydown; `true` means the editor kept the key, `false` lets the browser move focus. */
  const press = (key: "Tab" | "Escape" | "ArrowLeft", shiftKey = false) => {
    const keyCode = { Tab: 9, Escape: 27, ArrowLeft: 37 }[key];
    const event = new KeyboardEvent("keydown", { key, keyCode, shiftKey, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const text = () => view.state.doc.toString();
  const selected = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  return {
    view,
    press,
    text,
    selected,
    [Symbol.dispose]: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("note editor Tab key", () => {
  if (isServer) {
    test.skip("Tab behavior runs with browser export conditions", () => {});
    return;
  }

  test("paragraphs get two spaces at the cursor and lose up to two with Shift+Tab", () => {
    using editor = mount("Plan the trip", { selection: "Plan".length });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("Plan   the trip");
    expect(editor.view.state.selection.main.head).toBe("Plan  ".length);

    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe("Plan   the trip");

    editor.view.dispatch({ changes: { from: 0, insert: "   " } });
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe(" Plan   the trip");
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe("Plan   the trip");
    // Nothing left to remove: the key still stays in the editor.
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe("Plan   the trip");
  });

  test("a selection indents every selected line", () => {
    const doc = "First line\nSecond line\nThird line";
    using editor = mount(doc, { selection: { anchor: 2, head: doc.indexOf("Third") } });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("  First line\n  Second line\nThird line");
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe(doc);
  });

  test("list items nest and lift one Markdown level wherever the cursor is", () => {
    const bullets = "- Passport\n- Charger";
    using bulletEditor = mount(bullets, { selection: bullets.indexOf("Char") });
    expect(bulletEditor.press("Tab")).toBe(true);
    expect(bulletEditor.text()).toBe("- Passport\n  - Charger");
    expect(bulletEditor.selected()).toBe("");
    expect(bulletEditor.view.state.sliceDoc(bulletEditor.view.state.selection.main.head)).toBe("Charger");
    expect(bulletEditor.press("Tab", true)).toBe(true);
    expect(bulletEditor.text()).toBe(bullets);

    // An ordered item nests under the content column of the item above.
    const steps = "1. Pack\n2. ";
    using orderedEditor = mount(steps, { selection: steps.length });
    expect(orderedEditor.press("Tab")).toBe(true);
    expect(orderedEditor.text()).toBe("1. Pack\n   2. ");
    expect(orderedEditor.view.state.selection.main.head).toBe(orderedEditor.text().length);
    expect(orderedEditor.press("Tab", true)).toBe(true);
    expect(orderedEditor.text()).toBe(steps);

    // A top-level item has nothing to lift.
    expect(orderedEditor.press("Tab", true)).toBe(true);
    expect(orderedEditor.text()).toBe(steps);
  });

  test("tables move between cells, including empty ones, without changing the note", () => {
    const doc = "| Item | Owner |\n| --- | --- |\n| Tent |  |";
    using editor = mount(doc, { selection: doc.indexOf("Item") + 1 });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.selected()).toBe("Owner");
    expect(editor.press("Tab")).toBe(true);
    expect(editor.selected()).toBe("Tent");
    expect(editor.press("Tab")).toBe(true);
    expect(editor.selected()).toBe("");
    expect(editor.view.state.selection.main.head).toBe(doc.lastIndexOf("|  |") + 2);
    // The last cell keeps the cursor.
    expect(editor.press("Tab")).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(doc.lastIndexOf("|  |") + 2);

    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.selected()).toBe("Tent");
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.selected()).toBe("Owner");
    expect(editor.text()).toBe(doc);
  });

  test("code blocks indent like text, even when a line looks like a list item", () => {
    const doc = "```yaml\nteams:\n- ops\n```";
    using editor = mount(doc, { selection: doc.indexOf("- ops") + "- ops".length });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("```yaml\nteams:\n- ops  \n```");

    editor.view.dispatch({ selection: { anchor: doc.indexOf("teams") } });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("```yaml\n  teams:\n- ops  \n```");
    expect(editor.press("Tab", true)).toBe(true);
    expect(editor.text()).toBe("```yaml\nteams:\n- ops  \n```");
  });

  test("Esc, then Tab leaves the editor without changing the note", () => {
    using editor = mount("- Passport\n- Charger", { selection: "- Passport\n- Charger".length });
    expect(editor.press("Escape")).toBe(false);
    expect(editor.press("Tab")).toBe(false);
    expect(editor.press("Tab", true)).toBe(false);
    expect(editor.text()).toBe("- Passport\n- Charger");

    // Any other key ends the escape; Tab indents again.
    editor.press("ArrowLeft");
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("- Passport\n  - Charger");
  });

  test("with the focus preference, Tab and Shift+Tab stay with the browser", () => {
    using editor = mount("- Passport\n- Charger", { selection: "- Passport\n- Charger".length, tabIndents: false });
    expect(editor.press("Tab")).toBe(false);
    expect(editor.press("Tab", true)).toBe(false);
    expect(editor.text()).toBe("- Passport\n- Charger");
  });

  test("a read-only note never keeps Tab", () => {
    using editor = mount("Plan the trip", { selection: 4, extensions: [EditorState.readOnly.of(true)] });
    expect(editor.press("Tab")).toBe(false);
    expect(editor.press("Tab", true)).toBe(false);
    expect(editor.text()).toBe("Plan the trip");
  });
});
