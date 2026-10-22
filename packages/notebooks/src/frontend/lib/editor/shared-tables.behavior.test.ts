import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { clipboard } from "@k2b/stdlib/browser";
import type { TableHost } from "@k2b/ui/text-editor";
import { findTables } from "@k2b/ui/text-editor/model";
import { createDomTestHarness } from "../../../../../ui/test/dom";

// The public browser entry defines Solid controls at import time. Install the
// DOM before importing it, as in the existing Notebook table behavior harness.
const bootstrap = createDomTestHarness();
const { tableGrid, tableHost } = await import("@k2b/ui/text-editor");
const { namedBlocksExtension } = await import("./named-blocks");
const { createNotebookTablePresentation, notebookSourceFormulasExtension } = await import("./shared-tables");
const { formulaPreviewWidget } = await import("./tables");
bootstrap.cleanup();

const mount = (doc: string, mode: "grid" | "source" = "grid", locale = "de") => {
  const dom = createDomTestHarness();
  document.documentElement.lang = locale;
  const adapter = createNotebookTablePresentation({ notebookId: "ABC123" });
  const host: TableHost = {
    undo() {},
    redo() {},
    boundary() {},
    cellLabel: (r, c) => `${r}, ${c}`,
    maxLength: 10000,
    maxPasteCells: 2000,
    onError() {},
    onRecovery() {},
    renderCell: adapter.renderCell,
  };
  const source = notebookSourceFormulasExtension();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      extensions: mode === "grid" ? [tableHost.of(host), tableGrid(), adapter.extension, namedBlocksExtension()] : [source],
    }),
  });
  return {
    dom,
    view,
    async destroy() {
      view.destroy();
      await Promise.resolve();
      dom.cleanup();
    },
  };
};

const cell = (root: HTMLElement, row: number, column: number): HTMLElement => {
  const element = root.querySelector<HTMLElement>(`.ste-cell[data-r="${row}"][data-c="${column}"]`);
  if (!element) throw new Error(`Missing cell ${row}, ${column}`);
  return element;
};

afterEach(() => {
  spyOn(clipboard, "copy").mockRestore();
});

describe("Notebook shared table presentation", async () => {
  test("untouched cells evaluate, the active cell shows source, and dependency edits refresh results", async () => {
    const doc = "| Hours | Cost |\n| --- | --- |\n| 2 | =Hours*1.5 |";
    const h = mount(doc);
    try {
      expect(cell(h.dom.root, 1, 1).textContent).toBe("3");
      const formula = cell(h.dom.root, 1, 1);
      formula.focus();
      expect(formula.textContent).toBe("=Hours*1.5");
      expect(formula.querySelector(".md-formula-ok")).toBeNull();
      const hours = cell(h.dom.root, 1, 0);
      hours.focus();
      hours.textContent = "4";
      hours.dispatchEvent(new Event("input", { bubbles: true }));
      expect(cell(h.dom.root, 1, 1).textContent).toBe("6");
      expect(h.view.state.doc.toString()).toBe(doc.replace("| 2 |", "| 4 |"));
      expect(h.view.state.doc.toString()).toContain("=Hours*1.5");
    } finally {
      await h.destroy();
    }
  });

  test("extra columns remain visible, preserve named references, and never persist padding or results", async () => {
    const doc = "| First \\| Last | Cost |\n| --- | --- |\n| Ada | =LEN(`First \\| Last`) | extra | =Cost+1 |\n| Grace |";
    const h = mount(doc);
    try {
      expect(h.dom.root.querySelectorAll("th")).toHaveLength(4);
      expect(cell(h.dom.root, 0, 0).textContent).toBe("First | Last");
      expect(cell(h.dom.root, 0, 2).textContent).toBe("");
      expect(cell(h.dom.root, 1, 1).textContent).toBe("3");
      expect(cell(h.dom.root, 1, 2).textContent).toBe("extra");
      expect(cell(h.dom.root, 1, 3).textContent).toBe("4");
      expect(cell(h.dom.root, 2, 3).textContent).toBe("");
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      await h.destroy();
    }
  });

  test("cell presentation keeps inline markup, links, dates, progress and total rows", async () => {
    const doc =
      "| Item | Value |\n| --- | ---: |\n| **Work** [Note](note://5ARr8F) [Web](https://example.test) #garden | =PROGRESS(1,4) |\n| 2026-05-14T18:01:15.575Z | 1.5 |\n| Total | =SUM(Value) |";
    const h = mount(doc);
    try {
      expect(h.dom.root.querySelector("strong")?.textContent).toBe("Work");
      expect(h.dom.root.querySelector('a[href="/app/notebooks/ABC123/notes/5ARr8F"]')).not.toBeNull();
      expect(h.dom.root.querySelector('a[href="https://example.test"]')).not.toBeNull();
      expect(h.dom.root.querySelector('a[href="/app/notebooks/ABC123/tags/garden"]')).not.toBeNull();
      expect(h.dom.root.querySelector("time")?.getAttribute("datetime")).toBe("2026-05-14T18:01:15.575Z");
      expect(h.dom.root.querySelector(".md-table-progress-fill")?.getAttribute("style")).toBe("width:25%");
      expect(cell(h.dom.root, 3, 0).hasAttribute("data-notebook-total")).toBe(true);
      expect(cell(h.dom.root, 3, 1).hasAttribute("data-notebook-total")).toBe(true);
      expect(cell(h.dom.root, 2, 1).textContent).toBe("1.5");
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      await h.destroy();
    }
  });

  test("formula errors stay localized and inert", async () => {
    const h = mount("| Preis |\n| --- |\n| =pries |\n| =1/0 |");
    const copy = spyOn(clipboard, "copy").mockResolvedValue(undefined);
    try {
      const error = cell(h.dom.root, 1, 0).querySelector<HTMLElement>(".md-formula-error");
      expect(error?.title).toContain("Unbekannte Spalte");
      expect(error?.title).toContain("Vorschlag: Preis");
      expect(cell(h.dom.root, 2, 0).querySelector<HTMLElement>(".md-formula-error")?.title).toContain("nicht durch null teilen");
      expect(h.dom.root.querySelector(".cm-notebook-formula-copy")).toBeNull();
      error?.click();
      expect(copy).not.toHaveBeenCalled();
    } finally {
      await h.destroy();
    }
  });

  test("grid copy uses the evaluated localized result and reports rejection with retry", async () => {
    const doc = "| Value |\n| --- |\n| =1.5 |";
    const h = mount(doc);
    const copy = spyOn(clipboard, "copy").mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    try {
      const button = h.dom.root.querySelector<HTMLButtonElement>(".cm-notebook-formula-copy")!;
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(button.textContent).toContain("Kopieren fehlgeschlagen");
      expect(button.disabled).toBe(false);
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(copy).toHaveBeenLastCalledWith("1,5");
      expect(button.textContent).toBe("Kopiert");
      expect(h.view.state.doc.toString()).toBe(doc);
    } finally {
      await h.destroy();
    }
  });

  test("named table captions use the editable source once, including a separated handle", async () => {
    const doc = "@budget\n\n| Hours | Cost |\n| --- | --- |\n| 2 | =Hours*1.5 |";
    const h = mount(doc);
    try {
      const captions = h.dom.root.querySelectorAll("[data-block-name=budget]");
      expect(captions).toHaveLength(1);
      expect(captions[0]?.textContent).toBe("@budget");
      expect(h.dom.root.querySelector(".cm-named-block-handle")).toBeNull();
      expect(h.dom.root.querySelector(".ste-table")?.textContent).not.toContain("@budget");
      const at = doc.indexOf("budget");
      h.view.dispatch({ changes: { from: at, to: at + 6, insert: "plan" } });
      expect(h.dom.root.querySelector("[data-block-name=plan]")?.textContent).toBe("@plan");
      expect(h.view.state.doc.toString()).toBe(doc.replace("budget", "plan"));
    } finally {
      await h.destroy();
    }
  });

  test("source chips evaluate extra cells, refresh dependencies and copy results without replacing source", async () => {
    const doc = "| Hours | Cost |\n| --- | --- |\n| 2 | =Hours*1.5 | =Cost+1 |\n| 4 | =1/0 |";
    const h = mount(doc, "source");
    const copy = spyOn(clipboard, "copy").mockResolvedValue(undefined);
    try {
      expect(h.dom.root.querySelector(".ste-table, .cm-table-widget")).toBeNull();
      expect(h.dom.root.querySelectorAll(".cm-formula-preview")).toHaveLength(3);
      const chip = h.dom.root.querySelector<HTMLElement>(".cm-formula-preview")!;
      expect(chip.textContent).toBe(" → 3 ");
      chip.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(copy).toHaveBeenLastCalledWith("3");
      expect(chip.textContent).toBe(" kopiert ");
      const at = doc.indexOf("| 2 |") + 2;
      h.view.dispatch({ changes: { from: at, to: at + 1, insert: "3" } });
      expect(h.dom.root.querySelector(".cm-formula-preview")?.textContent).toBe(" → 4,5 ");
      expect(h.dom.root.querySelectorAll(".cm-formula-preview")[1]?.textContent).toBe(" → 5,5 ");
      expect(h.dom.root.querySelector(".cm-formula-preview-error")?.textContent).toContain("nicht durch null teilen");
      expect(h.view.state.doc.toString()).toBe(doc.replace("| 2 |", "| 3 |"));
    } finally {
      await h.destroy();
    }
  });

  test("source-only extension contributes no keymap, block replacements or captions", async () => {
    const doc = "@budget\n| Hours |\n| --- |\n| =1.5 |";
    const extension = notebookSourceFormulasExtension({ sourceVisible: (_state, table) => table.from > 0 });
    const state = EditorState.create({ doc, extensions: [extension] });
    expect(state.facet(keymap)).toEqual([]);
    const decorations = state.facet(EditorView.decorations);
    let count = 0;
    for (const set of decorations) {
      if (typeof set === "function") throw new Error("Expected state decorations");
      set.between(0, doc.length, (from, to, value) => {
        expect(from).toBe(to);
        expect(value.spec.block).not.toBe(true);
        count++;
      });
    }
    expect(count).toBe(1);
    const hidden = EditorState.create({ doc, extensions: [notebookSourceFormulasExtension({ sourceVisible: () => false })] });
    expect(hidden.facet(EditorView.decorations)[0]).toMatchObject({ size: 0 });
    expect(findTables(doc)).toHaveLength(1);
  });

  test("source-copy rejection stays visible and can be retried, while error chips stay inert", async () => {
    const h = mount("| Value |\n| --- |\n| =1.5 |\n| =1/0 |", "source");
    const copy = spyOn(clipboard, "copy").mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    try {
      const chip = h.dom.root.querySelector<HTMLElement>(".cm-formula-preview")!;
      const error = h.dom.root.querySelector<HTMLElement>(".cm-formula-preview-error")!;
      error.click();
      expect(copy).not.toHaveBeenCalled();
      chip.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(chip.textContent).toContain("Kopieren fehlgeschlagen");
      expect(chip.textContent).toContain("1,5");
      expect(chip.getAttribute("role")).toBe("button");
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(copy).toHaveBeenLastCalledWith("1,5");
      expect(chip.textContent).toBe(" kopiert ");
    } finally {
      await h.destroy();
    }
  });

  test("equal source widgets dispose copy work by DOM lifetime", async () => {
    const h = mount("plain", "source");
    let finishCopy: () => void = () => {
      throw new Error("Copy did not start");
    };
    const copy = spyOn(clipboard, "copy").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    );
    try {
      const first = formulaPreviewWidget({ kind: "ok", value: 1.5 }, "de");
      const equal = formulaPreviewWidget({ kind: "ok", value: 1.5 }, "de");
      expect(first.eq(equal)).toBe(true);
      const span = first.toDOM(h.view);
      h.dom.root.append(span);
      span.click();
      // CodeMirror can retain DOM while assigning an equal widget instance.
      equal.destroy(span);
      finishCopy();
      await Promise.resolve();
      await Promise.resolve();
      expect(span.textContent).toBe(" → 1,5 ");
      expect(span.classList.contains("cm-formula-preview-copied")).toBe(false);

      copy.mockResolvedValue(undefined);
      const live = first.toDOM(h.view);
      h.dom.root.append(live);
      live.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(live.textContent).toBe(" kopiert ");
      const clear = spyOn(window, "clearTimeout");
      try {
        equal.destroy(live);
        expect(clear).toHaveBeenCalledTimes(1);
      } finally {
        clear.mockRestore();
      }
    } finally {
      await h.destroy();
    }
  });

  test("link presses preserve their navigation target without entering cell editing", async () => {
    const h = mount("| Item |\n| --- |\n| [Note](note://5ARr8F) |");
    try {
      const link = cell(h.dom.root, 1, 0).querySelector<HTMLAnchorElement>("a")!;
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      link.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      expect(link.getAttribute("href")).toBe("/app/notebooks/ABC123/notes/5ARr8F");
      expect(cell(h.dom.root, 1, 0).dataset.editing).not.toBe("1");
      expect(link.contentEditable).toBe("false");
    } finally {
      await h.destroy();
    }
  });

  test("rendering inherits the supplied UI locale and leaves the parsed model unchanged", async () => {
    const dom = createDomTestHarness();
    try {
      document.documentElement.lang = "en";
      const table = findTables("| Value |\n| --- |\n| =1.5 | extra |")[0]!;
      const original = structuredClone(table);
      const adapter = createNotebookTablePresentation({ notebookId: "ABC123", locale: () => "de-DE" });
      const element = document.createElement("div");
      adapter.renderCell(element, "=1.5", table, 1, 0);
      expect(element.textContent).toBe("1,5");
      adapter.renderCell(element, "extra", table, 1, 1);
      expect(element.textContent).toBe("extra");
      expect(table).toEqual(original);
    } finally {
      dom.cleanup();
    }
  });

  test("source scanning leaves fenced and nested tables alone", async () => {
    const doc = "```md\n| A |\n| --- |\n| =1 |\n```\n\n> | A |\n> | --- |\n> | =2 |";
    const h = mount(doc, "source");
    try {
      expect(h.dom.root.querySelector(".cm-formula-preview")).toBeNull();
    } finally {
      await h.destroy();
    }
  });
});
