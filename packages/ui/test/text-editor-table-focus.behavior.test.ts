import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findTables, gridLine } from "../src/text-editor/markdown-table";
import { runTableAction, type TableFocusTarget, tableGrid, tableHost } from "../src/text-editor/table";
import { createDomTestHarness } from "./dom";

const initial = "Before\n\n| Item |\n| --- |\n| Paper |\n\nAfter";
const expanded = "Remote preface\n\nBefore\n\n| Item | New |\n| --- | --- |\n| Paper | Here |\n\nAfter";
const mount = () => {
  const dom = createDomTestHarness();
  const pending = Promise.withResolvers<TableFocusTarget>();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc: initial,
      extensions: [
        tableHost.of({
          undo() {},
          redo() {},
          boundary() {},
          cellLabel: (r, c) => `${r},${c}`,
          maxLength: 10_000,
          maxPasteCells: 2_000,
          onError() {},
          onRecovery() {},
          structure: { available: () => true, perform: () => pending.promise },
        }),
        tableGrid(),
      ],
    }),
  });
  const cell = (r: number, c: number) => dom.root.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${r}"][data-c="${c}"]`)!;
  cell(1, 0).focus();
  runTableAction(view, findTables(initial)[0]!.from, 1, 0, "colRight");
  const resolve: TableFocusTarget = () => {
    const t = findTables(view.state.doc.toString())[0]!;
    return { tableFrom: t.from, rowFrom: gridLine(t, 1)!.from, columnFrom: t.lines[0]!.cells[1]!.from, row: 1, column: 1 };
  };
  return {
    dom,
    view,
    pending,
    resolve,
    cell,
    cleanup: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("server actions focus their freshly resolved cell after intervening document movement", async () => {
  const h = mount();
  try {
    h.view.dispatch({ changes: { from: 0, to: h.view.state.doc.length, insert: expanded } });
    h.pending.resolve(h.resolve);
    await flush();
    expect(h.dom.document.activeElement).toBe(h.cell(1, 1));
    expect(h.view.state.doc.toString()).toBe(expanded);
  } finally {
    h.cleanup();
  }
});

test("a newer user gesture owns focus while a structural action is pending", async () => {
  const h = mount();
  try {
    await flush();
    h.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    h.view.dispatch({ changes: { from: 0, to: h.view.state.doc.length, insert: expanded } });
    h.view.focus();
    h.pending.resolve(h.resolve);
    await flush();
    expect(h.dom.document.activeElement).toBe(h.view.contentDOM);
  } finally {
    h.cleanup();
  }
});

test("a deleted server focus target never falls back to the neighboring cell", async () => {
  const h = mount();
  try {
    h.view.dispatch({ changes: { from: 0, to: h.view.state.doc.length, insert: expanded } });
    h.view.focus();
    h.pending.resolve(() => null);
    await flush();
    expect(h.dom.document.activeElement).toBe(h.view.contentDOM);
    expect(h.view.state.doc.toString()).toBe(expanded);
  } finally {
    h.cleanup();
  }
});
