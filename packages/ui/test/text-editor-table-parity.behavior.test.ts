import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  copyTable,
  editTableSource,
  type MenuAction,
  runMenuAction,
  runTableAction,
  type TableHost,
  tableActionEnabled,
  tableGrid,
  tableHost,
} from "../src/text-editor/table";
import { createDomTestHarness } from "./dom";

const initial = "Intro\n\n| Item | Cost |\n| --- | ---: |\n| Paper | 4 |\n| Ink | 2 |\n\nAfter";
const mount = (structure?: TableHost["structure"], doc = initial, renderCell?: TableHost["renderCell"]) => {
  const dom = createDomTestHarness();
  const errors: string[] = [];
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      extensions: [
        tableHost.of({
          undo() {},
          redo() {},
          boundary() {},
          cellLabel: (r, c) => `${r}, ${c}`,
          maxLength: 10_000,
          maxPasteCells: 2_000,
          onRecovery() {},
          onError: (code) => errors.push(code),
          structure,
          renderCell,
        }),
        tableGrid(),
      ],
    }),
  });
  const cell = (r: number, c: number) => dom.root.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${r}"][data-c="${c}"]`)!;
  const key = (r: number, c: number, key: string, extra: KeyboardEventInit = {}) => {
    cell(r, c).focus();
    cell(r, c).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  };
  return {
    dom,
    view,
    errors,
    cell,
    key,
    cleanup() {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("approved table frontend parity", () => {
  test("Enter moves down before appending and leaves an empty last row without adding another", () => {
    const h = mount();
    try {
      h.key(1, 1, "Enter");
      expect(h.dom.document.activeElement === h.cell(2, 1)).toBe(true);
      expect(h.view.state.doc.toString()).toBe(initial);
      h.key(2, 1, "Enter");
      expect(h.dom.document.activeElement === h.cell(3, 1)).toBe(true);
      h.key(3, 1, "Enter");
      expect(h.dom.document.activeElement === h.view.contentDOM).toBe(true);
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("cell Tab selects only the next cell and Ctrl+A remains scoped to that cell", () => {
    const h = mount();
    try {
      h.key(1, 0, "Tab");
      expect(h.dom.document.activeElement === h.cell(1, 1)).toBe(true);
      expect(h.dom.document.getSelection()?.toString()).toBe("4");
      h.key(1, 1, "a", { ctrlKey: true });
      expect(h.dom.document.getSelection()?.toString()).toBe("4");
      expect(h.dom.root.querySelectorAll('.k2b-ste-cell[tabindex="0"]')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("right-click and grips emit the same menu event with the actual target cell", () => {
    const h = mount();
    try {
      const targets: HTMLElement[] = [];
      h.dom.root.addEventListener("k2b-ste-cell-menu", (event) => targets.push((event as CustomEvent).detail.cell));
      const cell = h.cell(1, 0);
      cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
      cell.parentElement!.querySelector<HTMLButtonElement>(".k2b-ste-rowMenu")!.click();
      expect(targets).toEqual([cell, cell]);
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("invalid local Markdown is retained, and discard never touches shared source", () => {
    const h = mount();
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      editTableSource(h.view, wrap);
      const source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: "broken draft" } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      expect(wrap.querySelector<HTMLElement>(".k2b-ste-source-error")!.hidden).toBe(false);
      expect(source.state.doc.toString()).toBe("broken draft");
      expect(h.view.state.doc.toString()).toBe(initial);
      Array.from(wrap.querySelectorAll<HTMLButtonElement>(".k2b-ste-source-error button"))
        .find((button) => button.textContent === "Discard changes")!
        .click();
      expect(wrap.querySelector(".k2b-ste-table-source")).toBeNull();
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("collaborative Markdown accepts cell edits and preserves unsupported structural drafts", () => {
    const h = mount({ available: () => true, perform: async () => {} });
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      editTableSource(h.view, wrap);
      let source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      const at = source.state.doc.toString().indexOf("Paper");
      source.dispatch({ changes: { from: at, to: at + 5, insert: "Card" } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      expect(h.view.state.doc.toString()).toBe(initial.replace("Paper", "Card"));
      expect(wrap.querySelector(".k2b-ste-table-source")).toBeNull();
      editTableSource(h.view, wrap);
      source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      const before = h.view.state.doc.toString();
      source.dispatch({ changes: { from: source.state.doc.length, insert: "\n| New | 3 |" } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      expect(wrap.querySelector(".k2b-ste-source-error")?.textContent).toContain("structure");
      expect(source.state.doc.toString()).toContain("| New | 3 |");
      expect(h.view.state.doc.toString()).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  test("Markdown separator errors name and select their source line", () => {
    const h = mount();
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      editTableSource(h.view, wrap);
      const source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      const separator = source.state.doc.line(2);
      source.dispatch({ changes: { from: separator.from, to: separator.to, insert: "| --- |" } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      const error = wrap.querySelector<HTMLElement>(".k2b-ste-source-error")!;
      expect(error.dataset.tone).toBe("error");
      expect(error.textContent).toContain("Line 2: The separator has 1 column, but the header has 2.");
      Array.from(error.querySelectorAll("button"))
        .find((button) => button.textContent === "Continue editing")!
        .click();
      expect(source.state.selection.main.from).toBe(source.state.doc.line(2).from);
      expect(source.state.selection.main.to).toBe(source.state.doc.line(2).to);
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("extra Markdown cells stay visible in a warning and can add missing columns in standalone mode", () => {
    const h = mount();
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      editTableSource(h.view, wrap);
      const source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      const at = source.state.doc.toString().indexOf("| Paper | 4 |");
      source.dispatch({ changes: { from: at, to: at + "| Paper | 4 |".length, insert: "| Paper | 4 | Extra |" } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      const error = wrap.querySelector<HTMLElement>(".k2b-ste-source-error")!;
      expect(error.dataset.tone).toBe("warning");
      expect(error.textContent).toContain("Line 3 has extra cells");
      expect(h.view.state.doc.toString()).toBe(initial);
      Array.from(error.querySelectorAll("button"))
        .find((button) => button.textContent === "Add missing columns")!
        .click();
      expect(wrap.querySelector(".k2b-ste-table-source")).toBeNull();
      expect(h.view.state.doc.toString()).toContain("| Paper | 4 | Extra |");
      expect(wrap.querySelectorAll("th")).toHaveLength(3);
      expect(wrap.querySelectorAll("tr[data-source-changed]").length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
  test("empty headers have no cells or grips, and visible rows retain source identities", () => {
    const doc = initial.replace("| Item | Cost |", "| | |");
    const h = mount(undefined, doc);
    try {
      expect(h.dom.root.querySelectorAll("th")).toHaveLength(0);
      expect(h.dom.root.querySelectorAll("tr")).toHaveLength(2);
      expect(h.dom.root.querySelectorAll('.k2b-ste-cell[data-r="0"]')).toHaveLength(0);
      expect(h.cell(1, 0).textContent).toBe("Paper");
      expect(h.cell(1, 0).tabIndex).toBe(0);
      expect(h.dom.root.querySelectorAll(".k2b-ste-columnMenu")).toHaveLength(2);
      expect(h.cell(1, 0).parentElement!.querySelector(".k2b-ste-columnMenu")).not.toBeNull();
      expect(h.dom.root.querySelector("tr")?.dataset.r).toBe("1");
      expect(h.view.state.doc.toString()).toBe(doc);
      h.key(1, 0, "Tab", { shiftKey: true });
      expect(h.dom.document.activeElement === h.view.contentDOM).toBe(true);
      // Happy DOM has no layout. Give the caret a single visible line.
      Object.defineProperty(h.dom.window.Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, bottom: 16, height: 16 }),
      });
      h.cell(1, 0).style.padding = "0px";
      h.key(1, 0, "ArrowUp");
      expect(h.dom.document.activeElement === h.view.contentDOM).toBe(true);
      h.cell(1, 0).focus();
      h.dom.document.getSelection()!.setBaseAndExtent(h.cell(1, 0).firstChild!, 0, h.cell(1, 0).firstChild!, 0);
      h.key(1, 0, "ArrowLeft");
      expect(h.dom.document.activeElement === h.view.contentDOM).toBe(true);
      h.cell(1, 1).focus();
      h.dom.document.getSelection()!.setBaseAndExtent(h.cell(1, 1).firstChild!, 1, h.cell(1, 1).firstChild!, 1);
      h.key(1, 1, "ArrowRight");
      expect(h.dom.document.activeElement === h.cell(2, 0)).toBe(true);
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      h.cleanup();
    }
  });

  test("a same-size remote header visibility change keeps the first body editable", () => {
    const h = mount();
    try {
      h.cell(1, 0).focus();
      const from = initial.indexOf("| Item | Cost |");
      h.view.dispatch({ changes: { from, to: from + "| Item | Cost |".length, insert: "| | |" } });
      expect(h.dom.root.querySelectorAll("th")).toHaveLength(0);
      expect(h.dom.document.activeElement === h.cell(1, 0)).toBe(true);
      expect(h.cell(1, 0).contentEditable).not.toBe("false");
      h.view.dispatch({ changes: { from, to: from + "| | |".length, insert: "| Item | Cost |" } });
      expect(h.dom.root.querySelectorAll("th")).toHaveLength(2);
      expect(h.dom.document.activeElement === h.cell(1, 0)).toBe(true);
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("moves use the shared model, keep focus on the moved cell and refuse boundaries", () => {
    const h = mount();
    try {
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      h.cell(1, 0).focus();
      expect(tableActionEnabled(h.view, wrap, "moveRowUp")).toBe(false);
      expect(tableActionEnabled(h.view, wrap, "moveRowDown")).toBe(true);
      expect(tableActionEnabled(h.view, wrap, "moveColLeft")).toBe(false);
      h.key(1, 0, "ArrowDown", { altKey: true });
      expect(h.view.state.doc.toString()).toContain("| Ink | 2 |\n| Paper | 4 |");
      expect(h.dom.document.activeElement === h.cell(2, 0)).toBe(true);
      expect(tableActionEnabled(h.view, wrap, "moveRowDown")).toBe(false);
      h.key(2, 0, "ArrowRight", { altKey: true });
      expect(h.cell(2, 1).textContent).toBe("Paper");
      expect(h.dom.document.activeElement === h.cell(2, 1)).toBe(true);
      expect(tableActionEnabled(h.view, wrap, "moveColRight")).toBe(false);
      h.key(2, 1, "ArrowLeft", { altKey: true });
      h.key(2, 0, "ArrowUp", { altKey: true });
      expect(h.view.state.doc.toString()).toBe(initial);
      h.cell(0, 0).focus();
      for (const action of ["rowAbove", "deleteRow", "moveRowUp", "moveRowDown"] as const)
        expect(tableActionEnabled(h.view, wrap, action)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("header toggles preserve values, and whole-table delete preserves surrounding prose", () => {
    const h = mount();
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      runMenuAction(h.view, wrap, "toggleHeader");
      expect(h.dom.root.querySelectorAll("th")).toHaveLength(0);
      expect(h.cell(1, 0).textContent).toBe("Item");
      expect(h.cell(2, 0).textContent).toBe("Paper");
      expect(h.dom.document.activeElement === h.cell(2, 0)).toBe(true);
      runMenuAction(h.view, wrap, "toggleHeader");
      expect(h.view.state.doc.toString()).toBe(initial);
      runMenuAction(h.view, wrap, "deleteTable");
      expect(h.view.state.doc.toString()).toBe("Intro\n\n\n\nAfter");
      expect(h.dom.root.querySelector("table")).toBeNull();
      expect(h.dom.document.activeElement === h.view.contentDOM).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("all new host structural actions are server-owned, including failures and offline boundaries", async () => {
    const calls: { action: MenuAction; row: number; column: number }[] = [];
    let online = true;
    let reject = false;
    const h = mount({
      available: () => online,
      perform: async (action, target) => {
        calls.push({ action, row: target.row, column: target.column });
        if (reject) throw new Error("server rejected");
      },
    });
    try {
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      const cases = [
        ["moveRowUp", 2, 1],
        ["moveRowDown", 1, 0],
        ["moveColLeft", 1, 1],
        ["moveColRight", 1, 0],
        ["toggleHeader", 1, 0],
        ["deleteTable", 1, 0],
      ] as const;
      for (const [action, row, column] of cases) {
        h.cell(row, column).focus();
        runMenuAction(h.view, wrap, action);
      }
      expect(calls.map((call) => call.action)).toEqual(cases.map(([action]) => action));
      expect(h.view.state.doc.toString()).toBe(initial);
      expect(h.dom.document.activeElement === h.cell(1, 0)).toBe(true); // No speculative asynchronous focus.
      online = false;
      for (const [action, row, column] of cases) {
        h.cell(row, column).focus();
        expect(tableActionEnabled(h.view, wrap, action)).toBe(false);
        runTableAction(h.view, initial.indexOf("| Item"), row, column, action);
      }
      expect(calls).toHaveLength(6);
      expect(h.errors).toEqual(Array(6).fill("structureUnavailable"));
      h.cell(2, 0).focus();
      expect(tableActionEnabled(h.view, wrap, "rowBelow")).toBe(true);
      online = true;
      reject = true;
      runMenuAction(h.view, wrap, "deleteTable");
      await Promise.resolve();
      await Promise.resolve();
      expect(h.errors.at(-1)).toBe("structureFailed");
      expect(h.view.state.doc.toString()).toBe(initial);
    } finally {
      h.cleanup();
    }
  });

  test("copy writes real TSV+HTML and exact Markdown, with hidden headers omitted and failures propagated", async () => {
    const doc = initial.replace("| Item | Cost |", "| | |").replace("Paper", "<Paper & \\| >");
    const h = mount(undefined, doc);
    const savedItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
    const writes: Record<string, Blob>[][] = [];
    const texts: string[] = [];
    class Item {
      constructor(readonly data: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: Item });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: Item[]) => {
          writes.push(items.map((item) => item.data));
        },
        writeText: async (text: string) => {
          texts.push(text);
        },
      },
    });
    try {
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      await copyTable(h.view, wrap, "table");
      expect(await writes[0]![0]!["text/plain"]!.text()).toBe("<Paper & | >\t4\nInk\t2");
      expect(await writes[0]![0]!["text/html"]!.text()).toBe(
        "<table><tr><td>&lt;Paper &amp; | &gt;</td><td>4</td></tr><tr><td>Ink</td><td>2</td></tr></table>",
      );
      await copyTable(h.view, wrap, "markdown");
      expect(texts).toEqual([doc.slice(doc.indexOf("| | |"), doc.indexOf("\n\nAfter"))]);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async () => {
            throw new Error("permission denied");
          },
          writeText: async () => {
            throw new Error("permission denied");
          },
        },
      });
      await expect(copyTable(h.view, wrap, "table")).rejects.toThrow("permission denied");
      await expect(copyTable(h.view, wrap, "markdown")).rejects.toThrow("permission denied");
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      if (savedItem) Object.defineProperty(globalThis, "ClipboardItem", savedItem);
      else Reflect.deleteProperty(globalThis, "ClipboardItem");
      h.cleanup();
    }
  });
  test("ragged columns cannot move, while extra cells remain explicitly removable", () => {
    const h = mount(undefined, "| Name |\n| --- |\n| Paper | Extra |");
    try {
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      h.cell(1, 1).focus();
      expect(tableActionEnabled(h.view, wrap, "moveColLeft")).toBe(false);
      expect(tableActionEnabled(h.view, wrap, "deleteCol")).toBe(true);
      runMenuAction(h.view, wrap, "deleteCol");
      expect(h.view.state.doc.toString()).toBe("| Name |\n| --- |\n| Paper |");
      h.cell(1, 0).focus();
      expect(tableActionEnabled(h.view, wrap, "deleteCol")).toBe(false);
      expect(tableActionEnabled(h.view, wrap, "deleteTable")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
  test("leaving per-table source at its hidden header returns to the first visible body row", () => {
    const doc = initial.replace("| Item | Cost |", "| | |");
    const h = mount(undefined, doc);
    try {
      h.cell(1, 0).focus();
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      editTableSource(h.view, wrap);
      const source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
      source.dispatch({ selection: { anchor: 1 } });
      wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
      expect(wrap.querySelector(".k2b-ste-table-source")).toBeNull();
      expect(h.dom.document.activeElement === h.cell(1, 0)).toBe(true);
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      h.cleanup();
    }
  });
  test("table copy uses the host's visible computed values and excludes its copy controls", async () => {
    const doc = "| Value |\n| --- |\n| =SUM(1,2) |";
    const h = mount(undefined, doc, (element, raw) => {
      element.textContent = raw.startsWith("=") ? "3" : raw;
      const button = document.createElement("button");
      button.textContent = "Copy value";
      element.append(button);
    });
    const values: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          values.push(text);
        },
      },
    });
    try {
      const wrap = h.dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      h.cell(1, 0).focus(); // The live cell now displays the raw formula.
      expect(h.cell(1, 0).textContent).toBe("=SUM(1,2)");
      await copyTable(h.view, wrap, "table");
      expect(values).toEqual(["Value\n3"]);
      await copyTable(h.view, wrap, "markdown");
      expect(values[1]).toBe(doc);
      expect(h.cell(1, 0).textContent).toBe("=SUM(1,2)");
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      h.cleanup();
    }
  });
});
