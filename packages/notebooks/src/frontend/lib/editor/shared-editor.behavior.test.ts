import { describe, expect, test } from "bun:test";
import { EditorState, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TableHost } from "@k2b/ui/text-editor";
import { createRoot, createSignal } from "solid-js";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../ui/test/dom";

// The public browser entry defines Solid controls at import time; install the DOM first.
const bootstrap = createDomTestHarness();
const { tableGrid, tableHost } = await import("@k2b/ui/text-editor");
const { caretIntoTableCell, cellAt, createDynamicExtensions, outsideTable, tableAround, tableCellPresence } = await import(
  "./shared-editor"
);
bootstrap.cleanup();

const doc = "Intro\n\n| Item | Cost |\n| --- | ---: |\n| Paper | 4 |\n| Ink | =SUM(Cost) |\n\nAfter";
const host: TableHost = {
  undo() {},
  redo() {},
  boundary() {},
  cellLabel: (row, column) => `${row}, ${column}`,
  maxLength: 10_000,
  maxPasteCells: 2_000,
  onError() {},
  onRecovery() {},
};
const frames = () => new Promise((resolve) => setTimeout(resolve, 40));
const cell = (root: HTMLElement, row: number, column: number) => {
  const element = root.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${row}"][data-c="${column}"]`);
  if (!element) throw new Error(`Missing cell ${row}, ${column}`);
  return element;
};

describe("Notebook shared editor adapter", () => {
  test("reactive extensions reconfigure only their own compartment of the one view", () => {
    const dom = createDomTestHarness();
    const marker = Facet.define<string, string[]>();
    const [mode, setMode] = createSignal("rich");
    let dispose!: () => void;
    let extensions!: ReturnType<typeof createDynamicExtensions>;
    createRoot((root) => {
      dispose = root;
      extensions = createDynamicExtensions();
      extensions.add(marker.of("static"));
      extensions.add(() => marker.of(mode()));
    });
    const view = new EditorView({ parent: dom.root, state: EditorState.create({ extensions: extensions.extension() }) });
    try {
      extensions.attach(view);
      expect(view.state.facet(marker)).toEqual(["static", "rich"]);
      setMode("source");
      expect(view.state.facet(marker)).toEqual(["static", "source"]);
    } finally {
      dispose();
      view.destroy();
      dom.cleanup();
    }
  });

  test("table lookup addresses grid cells and moves block insertions after the table", () => {
    const state = EditorState.create({ doc });
    const table = tableAround(state, doc.indexOf("Paper"));
    expect(table?.from).toBe(doc.indexOf("| Item"));
    expect(cellAt(table!, doc.indexOf("Paper") + 2)).toMatchObject({ row: 1, column: 0 });
    expect(cellAt(table!, doc.indexOf("=SUM"))).toMatchObject({ row: 2, column: 1 });
    expect(outsideTable(state, doc.indexOf("Paper"))).toBe(table!.to);
    expect(outsideTable(state, doc.indexOf("After"))).toBe(doc.indexOf("After"));
  });

  test("a participant's caret marks the grid cell with their name and color, and leaving clears it", async () => {
    const dom = createDomTestHarness();
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("codemirror");
    ytext.insert(0, doc);
    const awareness = new Awareness(ydoc);
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ydoc));
    const peer = new Awareness(peerDoc);
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc, extensions: [tableHost.of(host), tableGrid(), tableCellPresence(ytext, awareness)] }),
    });
    try {
      const head = Y.createRelativePositionFromTypeIndex(peerDoc.getText("codemirror"), doc.indexOf("Paper") + 1);
      peer.setLocalState({ user: { userId: "u2", name: "Paul", color: "#0a7" }, cursor: { anchor: head, head } });
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peerDoc.clientID]), "remote");
      await frames();
      const marked = cell(dom.root, 1, 0).parentElement!;
      expect(marked.getAttribute("data-peer")).toBe("Paul");
      expect(marked.style.getPropertyValue("--pc")).toBe("#0a7");
      expect(dom.root.querySelectorAll("[data-peer]")).toHaveLength(1);
      const roots = [...ydoc.share.keys()];
      for (const tname of ["unknown-one", "unknown-two", "unknown-three"]) {
        peer.setLocalStateField("cursor", { head: { tname, type: null, item: null, assoc: 0 } });
        applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peerDoc.clientID]), "remote");
        await frames();
        expect(dom.root.querySelectorAll("[data-peer]")).toHaveLength(0);
        expect([...ydoc.share.keys()]).toEqual(roots);
      }
      peer.setLocalStateField("cursor", null);
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peerDoc.clientID]), "remote");
      await frames();
      expect(dom.root.querySelectorAll("[data-peer]")).toHaveLength(0);
    } finally {
      view.destroy();
      peer.destroy();
      awareness.destroy();
      dom.cleanup();
    }
  });

  test("a command that places the caret inside a table continues in that grid cell", async () => {
    const dom = createDomTestHarness();
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc, extensions: [tableHost.of(host), tableGrid(), caretIntoTableCell] }),
    });
    try {
      view.focus();
      const from = doc.indexOf("Paper");
      view.dispatch({ selection: { anchor: from, head: from + "Paper".length } });
      await Promise.resolve();
      await Promise.resolve();
      expect(dom.document.activeElement).toBe(cell(dom.root, 1, 0));
      expect(dom.document.getSelection()?.toString()).toBe("Paper");
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
