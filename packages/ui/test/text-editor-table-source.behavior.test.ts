import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findTables, gridLine } from "../src/text-editor/markdown-table";
import { editTableSource, type TableFocusTarget, type TableHost, tableGrid, tableHost } from "../src/text-editor/table";
import { createDomTestHarness } from "./dom";

const initial = "Before\n\n| Item |\n| --- |\n| Paper |\n\nAfter";
const replacement = "| Item | Price |\n| --- | ---: |\n| Paper | 4 |";
const mount = () => {
  const dom = createDomTestHarness();
  const pending = Promise.withResolvers<TableFocusTarget | void>();
  const captured: unknown[] = [];
  const recovered: string[] = [];
  const host: TableHost = {
    undo() {},
    redo() {},
    boundary() {},
    cellLabel: (r, c) => `${r},${c}`,
    maxLength: 10_000,
    maxPasteCells: 2_000,
    onError() {},
    onRecovery: (text) => recovered.push(text),
    structure: {
      available: () => true,
      perform: async () => {},
      replaceSource: (target, expected, source) => {
        captured.push({ target, expected, source });
        return pending.promise;
      },
    },
  };
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({ doc: initial, extensions: [tableHost.of(host), tableGrid()] }),
  });
  const wrap = dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
  wrap.querySelector<HTMLElement>('.k2b-ste-cell[data-r="1"][data-c="0"]')!.focus();
  editTableSource(view, wrap);
  const source = EditorView.findFromDOM(wrap.querySelector<HTMLElement>(".k2b-ste-table-source .cm-editor")!)!;
  source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: replacement } });
  const submit = () => wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!.click();
  return {
    dom,
    view,
    wrap,
    source,
    captured,
    recovered,
    pending,
    submit,
    cleanup: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("structural Markdown remains a frozen local draft until the server update is confirmed", async () => {
  const h = mount();
  try {
    h.submit();
    h.submit();
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]).toMatchObject({ expected: "| Item |\n| --- |\n| Paper |", source: replacement });
    expect(h.view.state.doc.toString()).toBe(initial);
    expect(h.source.state.readOnly).toBe(true);
    expect(h.wrap.querySelector("[aria-busy=true]")).not.toBeNull();
    const table = findTables(initial)[0]!;
    h.source.focus();
    h.view.dispatch({ changes: { from: table.from, to: table.to, insert: replacement } });
    expect(h.source.state.readOnly).toBe(true);
    expect(h.dom.document.activeElement).toBe(h.source.contentDOM);
    h.pending.resolve(() => {
      const current = findTables(h.view.state.doc.toString())[0]!;
      return {
        tableFrom: current.from,
        rowFrom: gridLine(current, 1)!.from,
        columnFrom: current.lines[0]!.cells[1]!.from,
        row: 1,
        column: 1,
      };
    });
    await flush();
    expect(h.wrap.querySelector(".k2b-ste-table-source")).toBeNull();
    expect(h.view.state.doc.toString()).toContain(replacement);
    expect(h.recovered).toEqual([]);
    expect(h.dom.document.activeElement).toBe(h.wrap.querySelector('.k2b-ste-cell[data-r="1"][data-c="1"]'));
  } finally {
    h.cleanup();
  }
});

test("a pointer-focused Apply keeps draft focus ownership while pending and rejects resubmission", async () => {
  const h = mount();
  try {
    const apply = h.wrap.querySelector<HTMLButtonElement>(".k2b-ste-source-bar button")!;
    apply.focus();
    h.submit();
    h.submit();
    expect(h.captured).toHaveLength(1);
    expect(h.dom.document.activeElement).toBe(apply);
    h.pending.reject(new Error("stale source"));
    await flush();
    expect(h.dom.document.activeElement).toBe(h.source.contentDOM);
    expect(h.source.state.readOnly).toBe(false);
    expect(h.view.state.doc.toString()).toBe(initial);
  } finally {
    h.cleanup();
  }
});

test("a rejected structural draft stays editable and copyable without changing shared text", async () => {
  const h = mount();
  try {
    h.submit();
    h.pending.reject(new Error("stale source"));
    await flush();
    expect(h.source.state.readOnly).toBe(false);
    expect(h.source.state.doc.toString()).toBe(replacement);
    expect(h.wrap.querySelector<HTMLElement>(".k2b-ste-source-error")!.hidden).toBe(false);
    expect(h.view.state.doc.toString()).toBe(initial);
  } finally {
    h.cleanup();
  }
});

test("disposing a pending structural draft preserves its text and tolerates a later receipt", async () => {
  const h = mount();
  h.submit();
  h.view.destroy();
  await flush();
  expect(h.recovered).toEqual([replacement]);
  h.pending.resolve();
  await flush();
  expect(h.recovered).toEqual([replacement]);
  h.dom.cleanup();
});

test("late source rejection preserves the user's newer focus and leaves the draft recoverable", async () => {
  const h = mount();
  try {
    h.submit();
    const other = h.dom.document.createElement("input");
    h.dom.root.append(other);
    other.focus();
    h.pending.reject(new Error("stale source"));
    await flush();
    expect(h.dom.document.activeElement === other).toBe(true);
    expect(h.source.state.readOnly).toBe(false);
    expect(h.source.state.doc.toString()).toBe(replacement);
    expect(h.wrap.querySelector<HTMLElement>(".k2b-ste-source-error")!.hidden).toBe(false);
    const resume = [...h.wrap.querySelectorAll<HTMLButtonElement>(".k2b-ste-source-error button")].find(
      (button) => button.textContent === "Continue editing",
    )!;
    resume.click();
    expect(h.dom.document.activeElement === h.source.contentDOM).toBe(true);
  } finally {
    h.cleanup();
  }
});
