import { describe, expect, test } from "bun:test";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Transaction } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { listsExtension } from "./lists";
import { markdownExtension } from "./markdown";
import { pressMissedEditor } from "./surface-press";

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
        if (from === position && decoration.spec.widget?.constructor.name === "TaskWidget") found = true;
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
