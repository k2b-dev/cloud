import { describe, expect, test } from "bun:test";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Transaction } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { markdownExtension } from "./markdown";
import { pressMissedEditor } from "./surface-press";

// Notebook block scanners load the UI browser export after its DOM globals exist.
const loading = createDomTestHarness();
const { listStateField, listsExtension } = await import("./lists");
loading.cleanup();

describe("editor checklist boxes", () => {
  if (isServer) {
    test.skip("editor checklist boxes run with browser export conditions", () => {});
    return;
  }

  const mount = (doc: string, caret: number) => {
    const dom = createDomTestHarness();
    const transactions: Transaction[] = [];
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [
          markdownExtension(),
          listsExtension(),
          EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
        ],
      }),
    });
    const press = (task: string) => {
      const line = Array.from(dom.root.querySelectorAll(".cm-line")).find((element) => element.textContent?.includes(task));
      const box = line?.querySelector<HTMLInputElement>(".custom-list-task-marker");
      if (!box) throw new Error(`No checklist box for "${task}".`);
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      box.dispatchEvent(event);
      return event;
    };
    return {
      view,
      transactions,
      press,
      cleanup: () => {
        view.destroy();
        dom.cleanup();
      },
    };
  };

  /** Whether a checklist box replaces the task marker at this position. */
  const boxAt = (view: EditorView, position: number) =>
    view.state.facet(EditorView.decorations).some((source) => {
      const set: DecorationSet = typeof source === "function" ? source(view) : source;
      let found = false;
      set.between(position, position, (from, _to, decoration) => {
        if (from === position && decoration.spec.widget?.constructor.name === "ListGutterWidget") found = true;
      });
      return found;
    });

  test("a list the parser reaches after the note opened gets its boxes", () => {
    const doc = `${"Some prose that fills the note.\n".repeat(40_000)}- [ ] Last task\n`;
    const { view, cleanup } = mount(doc, 0);
    try {
      const task = view.state.doc.line(view.state.doc.lines - 1).from;
      expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
      expect(boxAt(view, task)).toBe(false);
      forceParsing(view, doc.length, 5000);
      expect(boxAt(view, task)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("parser progress keeps the bullet dots and indent guides already on screen", () => {
    const doc = `- Groceries\n  - Milk\n${"Some prose that fills the note.\n".repeat(40_000)}`;
    const { view, cleanup } = mount(doc, 0);
    try {
      const dot = view.dom.querySelector(".custom-list-dot");
      const guide = view.dom.querySelector(".custom-list-guide");
      expect(dot).not.toBeNull();
      expect(guide).not.toBeNull();
      const tree = syntaxTree(view.state);
      const excluded = view.state.field(listStateField).excluded;
      expect(excluded).toBeDefined();
      forceParsing(view, doc.length, 5000);
      // The newer tree rebuilt the list decorations, but the unchanged widgets keep their elements.
      expect(syntaxTree(view.state)).not.toBe(tree);
      expect(view.state.field(listStateField).excluded).toBe(excluded);
      expect(view.dom.querySelector(".custom-list-dot") === dot).toBe(true);
      expect(view.dom.querySelector(".custom-list-guide") === guide).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("selection moves reuse the structure and activate only the parent's subtree", () => {
    const { view, cleanup } = mount("- root\n  - child\n    - grandchild\n  - sibling\n- outside\n  - other", 2);
    try {
      const before = view.state.field(listStateField);
      view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
      const after = view.state.field(listStateField);
      expect(after.structure.items).toBe(before.structure.items);
      const activeLines: Array<[number, string]> = [];
      after.active.between(0, view.state.doc.length, (from, _to, decoration) => {
        activeLines.push([view.state.doc.lineAt(from).number, decoration.spec.attributes.style]);
      });
      expect(activeLines).toEqual([
        [2, "--list-active-level: 0"],
        [3, "--list-active-level: 0"],
        [4, "--list-active-level: 0"],
      ]);
      view.dispatch({ selection: { anchor: view.state.doc.line(4).to } });
      expect(view.state.field(listStateField).active).toBe(after.active);
      view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
      const deeper = view.state.field(listStateField);
      expect(deeper.structure.items).toBe(before.structure.items);
      const levels: string[] = [];
      deeper.active.between(0, view.state.doc.length, (_from, _to, decoration) => {
        levels.push(decoration.spec.attributes.style);
      });
      expect(levels).toEqual(["--list-active-level: 1"]);
      view.dispatch({ selection: { anchor: view.state.doc.line(5).to } });
      expect(view.state.field(listStateField).active.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("a press ticks and unticks the box with one change, leaves the caret, and asks for no scrolling", () => {
    const doc = "Intro\n- [ ] Buy milk\n- [x] Call Ada\n";
    const { view, transactions, press, cleanup } = mount(doc, 2);
    try {
      forceParsing(view, doc.length, 5000);
      transactions.length = 0;
      press("Buy milk");
      press("Call Ada");
      expect(view.state.doc.toString()).toBe("Intro\n- [x] Buy milk\n- [ ] Call Ada\n");
      press("Buy milk");
      expect(view.state.doc.toString()).toBe("Intro\n- [ ] Buy milk\n- [ ] Call Ada\n");

      expect(transactions).toHaveLength(3);
      for (const transaction of transactions) {
        expect(transaction.changes.length).toBe(doc.length);
        let changed = "";
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changed += `${toA - fromA}:${inserted.toString()}`;
        });
        expect(changed === "3:[x]" || changed === "3:[ ]").toBe(true);
        expect(transaction.scrollIntoView).toBe(false);
        expect(transaction.selection).toBeUndefined();
      }
      expect(view.state.selection.main.head).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("uppercase tasks in ordered lists toggle only their task marker", () => {
    const { view, transactions, press, cleanup } = mount("3) [X] Done\n7) [ ] Next", 0);
    try {
      press("Done");
      press("Next");
      expect(view.state.doc.toString()).toBe("3) [ ] Done\n7) [x] Next");
      expect(view.state.selection.main.head).toBe(0);
      expect(transactions).toHaveLength(2);
      for (const transaction of transactions) {
        expect(transaction.selection).toBeUndefined();
        expect(transaction.scrollIntoView).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test("the note surface leaves a handled press alone, though ticking redrew the pressed box", () => {
    const { view, press, cleanup } = mount("- [ ] Buy milk\n", 0);
    try {
      forceParsing(view, view.state.doc.length, 5000);
      const event = press("Buy milk");
      expect(event.defaultPrevented).toBe(true);
      // The redraw took the pressed box out of the editor before the press reaches the surface.
      expect(event.target instanceof Element && event.target.closest(".cm-editor")).toBeFalsy();
      expect(pressMissedEditor(event)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("a press beside the editor still counts as a miss", () => {
    const { cleanup } = mount("- [ ] Buy milk\n", 0);
    try {
      const surface = document.createElement("div");
      document.body.append(surface);
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      surface.dispatchEvent(event);
      expect(pressMissedEditor(event)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
