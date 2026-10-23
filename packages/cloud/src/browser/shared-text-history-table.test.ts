import { expect, spyOn, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "../shared-text/anchors";
import { fromBase64, toBase64 } from "../shared-text/events";
import { createStructuralFixture } from "../shared-text/structural-history.test-fixture";
import type { SharedTextSyncEvent } from "../shared-text/types";
import { createSharedTextActionHistory } from "./shared-text-history";

const SOURCE = "| \ue000 |\n| --- |\n| \ue001 |";
const fixture = async (source = SOURCE) => {
  const f = createStructuralFixture(source);
  return {
    ...f,
    own: Object.assign(f.own, { undo: f.own.manager }),
    peer: Object.assign(f.peer, { undo: f.peer.manager }),
    publish: (replica = f.own) => f.accept(replica),
    deliver: async (event: { cursor: string; data: SharedTextSyncEvent }, replica = f.own) => {
      if (event.data.actionId) f.deliver(replica);
      else return f.accept(f.peer, fromBase64(event.data.payload), event.cursor);
    },
  };
};

test("ordered repair settles own column Undo after a peer aligns the inserted column", async () => {
  const f = await fixture();
  const { own, peer, action } = f;
  try {
    await action(own, "colLeft");
    await action(peer, "alignLeft");
    const colon = captureTextAnchor(own.text, own.text.toString().indexOf(":"));
    const aligned = own.text.toString();
    const hyphen = captureTextAnchor(own.text, T.findTables(aligned)[0]!.lines[1]!.cells[0]!.from + 1);
    expect(own.history.undoDepth()).toBe(1);
    expect(peer.history.undoDepth()).toBe(1);
    await own.history.undo();
    expect(own.text.toString()).toBe(aligned);
    expect(own.hints()).toBe(1);
    expect(resolveTextAnchor(own.text, colon)).not.toBeNull();
    expect(resolveTextAnchor(own.text, hyphen)).not.toBeNull();
    await own.history.redo();
    expect(T.findTables(own.text.toString())).toHaveLength(1);
    await own.history.undo();
    const beforeRepair = own.text.toString();
    const changes = T.repairTables(beforeRepair, 2_097_152);
    expect(changes.every((change) => change.from === change.to)).toBe(true);
    const settled = T.applyChanges(beforeRepair, changes);
    for (const marker of ["\ue000", "\ue001", ":"]) expect(settled.split(marker)).toHaveLength(2);
    expect(T.findTables(settled)).toHaveLength(1);
    expect(T.inspectTableStructure(settled)).toEqual({ extraCells: false, missingSeparator: false });
  } finally {
    f.destroy();
  }
});

for (const alignment of ["alignLeft", "alignCenter", "alignRight"] as const) {
  for (const column of [0, 1, 2]) {
    test(`retained ${alignment} column ${column} keeps identities and consumes exactly one Undo/Redo step`, async () => {
      const f = await fixture(
        T.tableFromGrid([
          ["A", "B"],
          ["C", "D"],
        ]),
      );
      const { own, peer } = f;
      try {
        own.text.insert(0, "earlier\n\n");
        own.undo.stopCapturing();
        await f.publish();
        await f.action(own, column === 2 ? "colRight" : "colLeft", column === 2 ? 1 : column);
        await f.action(peer, alignment, column);
        const aligned = own.text.toString();
        const colons = [...aligned.matchAll(/:/g)].map((match) => captureTextAnchor(own.text, match.index));
        const table = T.findTables(aligned)[0]!;
        const hyphens = table.lines[1]!.cells.map((cell) => captureTextAnchor(own.text, cell.from + cell.text.indexOf("-")));
        for (let cycle = 0; cycle < 3; cycle++) {
          expect(await own.history.undo()).not.toBeNull();
          expect(own.text.toString()).toBe(aligned);
          expect(own.history.undoDepth()).toBe(1);
          expect(own.history.redoDepth()).toBe(1);
          for (const anchor of [...colons, ...hyphens]) expect(resolveTextAnchor(own.text, anchor)).not.toBeNull();
          expect(T.findTables(own.text.toString())[0]!.align[column]).toBe(
            alignment === "alignLeft" ? "left" : alignment === "alignRight" ? "right" : "center",
          );
          expect(await own.history.redo()).not.toBeNull();
          expect(own.text.toString()).toBe(aligned);
        }
        expect(own.hints()).toBe(3);
        await own.history.undo();
        await own.history.undo();
        expect(own.text.toString()).toBe(aligned.replace("earlier\n\n", ""));
        await f.publish();
        expect(peer.text.toString()).toBe(own.text.toString());
      } finally {
        f.destroy();
      }
    });
  }
}

test("own typing and own-only insertion undo normally across replacement identities", async () => {
  const f = await fixture();
  const { own } = f;
  try {
    await f.action(own, "colLeft");
    for (let cycle = 0; cycle < 3; cycle++) {
      const cell = T.gridLine(T.findTables(own.text.toString())[0]!, 1)!.cells[0]!;
      own.text.insert(cell.from, "mine");
      own.undo.stopCapturing();
      await own.history.undo();
      expect(own.text.toString()).not.toContain("mine");
      await own.history.undo();
      expect(own.text.toString()).toBe(SOURCE);
      await own.history.redo();
      expect(T.findTables(own.text.toString())[0]!.columns).toBe(2);
    }
    expect(own.hints()).toBe(0);
  } finally {
    f.destroy();
  }
});

test("peer cell input retains the entire inserted column while own typing can undo", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const body = () => T.gridLine(T.findTables(own.text.toString())[0]!, 1)!.cells[0]!;
    own.text.insert(body().from, "mine");
    own.undo.stopCapturing();
    await f.publish();
    peer.text.insert(T.gridLine(T.findTables(peer.text.toString())[0]!, 1)!.cells[0]!.from, "peer");
    await f.publish(peer);
    const peerAnchor = captureTextAnchor(own.text, own.text.toString().indexOf("peer"));
    await own.history.undo();
    expect(own.text.toString()).not.toContain("mine");
    const withPeer = own.text.toString();
    await own.history.undo();
    expect(own.text.toString()).toBe(withPeer);
    expect(resolveTextAnchor(own.text, peerAnchor)).not.toBeNull();
    expect(T.findTables(withPeer)[0]!.lines.map((line) => line.cells.length)).toEqual([2, 2, 2]);
    expect(own.hints()).toBe(1);
  } finally {
    f.destroy();
  }
});

test("peer changes in a neighbouring column do not retain an own-only column", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    await f.action(peer, "alignRight", 1);
    const neighbour = T.gridLine(T.findTables(peer.text.toString())[0]!, 1)!.cells[1]!;
    peer.text.insert(neighbour.from, "neighbour");
    await f.publish(peer);
    const anchor = captureTextAnchor(own.text, own.text.toString().indexOf("neighbour"));
    await own.history.undo();
    const table = T.findTables(own.text.toString())[0]!;
    expect(table.columns).toBe(1);
    expect(table.align).toEqual(["right"]);
    expect(resolveTextAnchor(own.text, anchor)).not.toBeNull();
    expect(own.hints()).toBe(0);
  } finally {
    f.destroy();
  }
});

test("input in a later appended row depends on the same inserted column", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const table = T.findTables(peer.text.toString())[0]!;
    const append = T.insertRow(table, T.rowCount(table) - 1)[0]!;
    peer.text.insert(append.from, append.insert);
    const last = T.gridLine(T.findTables(peer.text.toString())[0]!, 2)!.cells[0]!;
    peer.text.insert(last.from, "later-row");
    await f.publish(peer);
    const before = own.text.toString();
    await own.history.undo();
    expect(own.text.toString()).toBe(before);
    expect(T.findTables(before)[0]!.lines.map((line) => line.cells.length)).toEqual([2, 2, 2, 2]);
    expect(own.hints()).toBe(1);
  } finally {
    f.destroy();
  }
});

test("successive retained column receipts each consume one history frame", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    own.text.insert(0, "earlier\n\n");
    own.undo.stopCapturing();
    await f.publish();
    await f.action(own, "colLeft");
    await f.action(peer, "alignLeft", 0);
    await f.action(own, "colRight", 0);
    await f.action(peer, "alignRight", 1);
    const before = own.text.toString();
    expect(own.doc.getMap("shared-text-history").size).toBe(0);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let step = 0; step < 2; step++) {
        expect(await own.history.undo()).not.toBeNull();
        expect(own.text.toString()).toBe(before);
        expect(own.history.undoDepth()).toBe(2 - step);
      }
      await own.history.redo();
      await own.history.redo();
      expect(own.text.toString()).toBe(before);
    }
    expect(own.hints()).toBe(6);
  } finally {
    f.destroy();
  }
});

for (const source of ["A | B\n--- | ---\nC | D\n", "| A | B |\r\n| --- | --- |\r\n| C | D |\r\n"]) {
  test(`retained insertion preserves ${source.includes("\r") ? "CRLF" : "omitted outer pipes"}`, async () => {
    const f = await fixture(source);
    const { own, peer } = f;
    try {
      await f.action(own, "colLeft", 0);
      await f.action(peer, "alignCenter", 0);
      const before = own.text.toString();
      await own.history.undo();
      expect(own.text.toString()).toBe(before);
      expect(T.findTables(before)[0]!.align).toEqual(["center", null, null]);
      await own.history.redo();
      await own.history.undo();
      expect(own.text.toString()).toBe(before);
      expect(own.hints()).toBe(2);
    } finally {
      f.destroy();
    }
  });
}

test("a late neighbouring edit does not restore an already undone own-only column", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const late = await f.action(peer, "alignCenter", 1, false);
    await own.history.undo();
    expect(T.findTables(own.text.toString())[0]!.columns).toBe(1);
    await f.deliver(late);
    expect(T.findTables(own.text.toString())[0]!.columns).toBe(1);
    expect(T.findTables(own.text.toString())[0]!.align).toEqual(["center"]);
    expect(own.hints()).toBe(0);
  } finally {
    f.destroy();
  }
});

test("provider echo filtering sends only ordinary typing, never a structural inverse or session marker", async () => {
  const f = await fixture();
  const { own, peer } = f;
  const uploads: Uint8Array[] = [];
  const update = (bytes: Uint8Array, origin: unknown) => {
    if (!own.history.isRemoteOrigin(origin)) uploads.push(bytes);
  };
  own.doc.on("update", update);
  try {
    await f.action(own, "colLeft");
    expect(uploads).toHaveLength(0);
    expect(own.doc.clientID).toBe(101);
    own.text.insert(T.gridLine(T.findTables(own.text.toString())[0]!, 1)!.cells[0]!.from, "mine");
    expect(uploads).toHaveLength(1);
    await f.publish();
    expect(peer.text.toString()).toBe(own.text.toString());
    expect(own.history.undoDepth()).toBe(2);
    await own.history.undo();
    await f.publish();
    const beforeInverse = uploads.length;
    await own.history.undo();
    expect(uploads).toHaveLength(beforeInverse);
    expect(own.text.toString()).toBe(SOURCE);
    expect(own.doc.getMap("shared-text-history").size).toBe(0);
  } finally {
    own.doc.off("update", update);
    f.destroy();
  }
});

test("late alignment restoration leaves the original Redo usable across repeated cycles", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const late = await f.action(peer, "alignCenter", 0, false);
    const anchor = captureTextAnchor(peer.text, peer.text.toString().indexOf(":"));
    await own.history.undo();
    await f.deliver(late);
    const restored = own.text.toString();
    expect(T.findTables(restored)[0]?.columns).toBe(2);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await own.history.redo()).not.toBeNull();
      expect(own.text.toString()).toBe(restored);
      expect(await own.history.undo()).not.toBeNull();
      expect(own.text.toString()).toBe(restored);
      expect(resolveTextAnchor(own.text, anchor)).not.toBeNull();
    }
    expect(own.hints()).toBe(4);
  } finally {
    f.destroy();
  }
});

test("peer alignment arriving after insertion Undo AND Redo still targets the inserted column", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const late = await f.action(peer, "alignCenter", 0, false);
    const colon = captureTextAnchor(peer.text, peer.text.toString().indexOf(":"));
    await own.history.undo();
    await own.history.redo();
    await f.deliver(late);
    const table = T.findTables(own.text.toString())[0]!;
    expect(table.columns).toBe(2);
    expect(table.align).toEqual(["center", null]);
    const at = resolveTextAnchor(own.text, colon)!;
    expect(at).toBeGreaterThanOrEqual(table.lines[1]!.cells[0]!.from);
    expect(at).toBeLessThan(table.lines[1]!.cells[0]!.to);
    const aligned = own.text.toString();
    await own.history.undo();
    expect(own.text.toString()).toBe(aligned);
  } finally {
    f.destroy();
  }
});

for (const kind of ["typing", "alignLeft", "alignCenter", "alignRight"] as const) {
  test(`late peer ${kind} after local insertion Undo retains accepted targets or preserves unconfirmed input without consuming newer history`, async () => {
    const f = await fixture();
    const { own, peer } = f;
    try {
      await f.action(own, "colLeft");
      let late: { cursor: string; data: SharedTextSyncEvent };
      if (kind === "typing") {
        peer.text.insert(T.gridLine(T.findTables(peer.text.toString())[0]!, 1)!.cells[0]!.from, "peer");
        late = {
          cursor: "s6t.history.0",
          data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(peer.doc)), originNodeId: "fixture", originPeerId: null },
        };
      } else late = await f.action(peer, kind, 0, false);
      const dependency = kind === "typing" ? "peer" : ":";
      const anchor = captureTextAnchor(peer.text, peer.text.toString().indexOf(dependency));
      await own.history.undo();
      expect(T.findTables(own.text.toString())[0]!.columns).toBe(kind === "typing" ? 1 : 2);
      own.text.insert(0, "newer\n\n");
      own.undo.stopCapturing();
      await f.publish();
      const result = await f.deliver(late);
      if (kind === "typing") {
        expect(result?.status).toBe("recoveryRequired");
        expect(peer.recovery.at(-1)!.update).toEqual(fromBase64(late.data.payload));
        expect(peer.recovery.at(-1)!.text).toContain("peer");
        expect(resolveTextAnchor(peer.text, anchor)).not.toBeNull();
      } else expect(resolveTextAnchor(own.text, anchor)).not.toBeNull();
      expect(T.inspectTableStructure(own.text.toString())).toEqual({ extraCells: false, missingSeparator: false });
      expect(own.history.undoDepth()).toBe(1);
      await own.history.undo();
      expect(own.text.toString()).not.toContain("newer");
      expect(T.findTables(own.text.toString())[0]!.columns).toBe(kind === "typing" ? 1 : 2);
    } finally {
      f.destroy();
    }
  });
}

// These schedules retain the actual peer item anchors. A rectangular string
// alone is insufficient: late input must still occupy its original column.
test("peer typing arriving after insertion Undo and Redo keeps its original cell", async () => {
  const f = await fixture();
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    const before = Y.encodeStateVector(peer.doc);
    const cell = T.gridLine(T.findTables(peer.text.toString())[0]!, 1)!.cells[0]!;
    peer.text.insert(cell.from, "late-peer");
    const anchor = captureTextAnchor(peer.text, cell.from);
    const late = Y.encodeStateAsUpdate(peer.doc, before);
    await own.history.undo();
    await own.history.redo();
    const result = await f.accept(peer, late);
    expect(result.status).toBe("recoveryRequired");
    expect(peer.recovery.at(-1)!.update).toEqual(late);
    expect(peer.recovery.at(-1)!.text).toContain("late-peer");
    // The canonical restored column remains empty. The original item stays
    // available at its original peer target in explicit recovery, unconfirmed.
    const table = T.findTables(peer.text.toString())[0]!;
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["late-peer", "\ue001"]);
    const at = resolveTextAnchor(peer.text, anchor)!;
    expect(at).toBeGreaterThanOrEqual(T.gridLine(table, 1)!.cells[0]!.from);
    expect(at).toBeLessThan(T.gridLine(table, 1)!.cells[0]!.to);
    expect(T.gridLine(T.findTables(own.text.toString())[0]!, 1)!.cells.map((cell) => cell.text)).toEqual(["", "\ue001"]);
    await own.history.undo();
    expect(own.text.toString()).toBe(SOURCE);
  } finally {
    f.destroy();
  }
});

for (const clear of [false, true]) {
  test(`late appended-row input retains its inserted column after Undo${clear ? " and history clear" : ""}`, async () => {
    const f = await fixture();
    const { own, peer } = f;
    try {
      await f.action(own, "colLeft");
      const before = Y.encodeStateVector(peer.doc);
      const table = T.findTables(peer.text.toString())[0]!;
      const append = T.insertRow(table, T.rowCount(table) - 1)[0]!;
      peer.text.insert(append.from, append.insert);
      const last = T.gridLine(T.findTables(peer.text.toString())[0]!, 2)!.cells[0]!;
      peer.text.insert(last.from, "late-appended");
      const anchor = captureTextAnchor(peer.text, last.from);
      const late = Y.encodeStateAsUpdate(peer.doc, before);
      await own.history.undo();
      if (clear) own.history.clear();
      const admitted = await f.accept(peer, late);
      expect(admitted.status).toBe("recoveryRequired");
      expect(peer.recovery.at(-1)!.update).toEqual(late);
      expect(peer.recovery.at(-1)!.text).toContain("late-appended");
      const peerTable = T.findTables(peer.text.toString())[0]!;
      expect(T.gridLine(peerTable, 2)!.cells.map((cell) => cell.text)).toEqual(["late-appended", ""]);
      const at = resolveTextAnchor(peer.text, anchor)!;
      expect(at).toBeGreaterThanOrEqual(T.gridLine(peerTable, 2)!.cells[0]!.from);
      expect(at).toBeLessThan(T.gridLine(peerTable, 2)!.cells[0]!.to);
      expect(own.text.toString()).toBe(SOURCE);
      expect(T.inspectTableStructure((await f.canonical()).text!)).toEqual({ extraCells: false, missingSeparator: false });
    } finally {
      f.destroy();
    }
  });
}

for (const neighbour of ["", "neighbour"]) {
  test(`Undo removes empty inserted-column syntax from an appended row with ${neighbour || "empty neighbour"}`, async () => {
    const f = await fixture();
    const { own, peer } = f;
    try {
      await f.action(own, "colLeft");
      const table = T.findTables(peer.text.toString())[0]!;
      const append = T.insertRow(table, T.rowCount(table) - 1)[0]!;
      peer.text.insert(append.from, append.insert);
      if (neighbour) peer.text.insert(T.gridLine(T.findTables(peer.text.toString())[0]!, 2)!.cells[1]!.from, neighbour);
      const anchor = neighbour ? captureTextAnchor(peer.text, peer.text.toString().indexOf(neighbour)) : undefined;
      await f.publish(peer);
      await own.history.undo();
      const settled = T.findTables(own.text.toString())[0]!;
      expect(settled.lines.map((line) => line.cells.length)).toEqual([1, 1, 1, 1]);
      expect(T.gridLine(settled, 2)!.cells.map((cell) => cell.text)).toEqual([neighbour]);
      expect(own.hints()).toBe(0);
      if (anchor) expect(resolveTextAnchor(own.text, anchor)).toBe(T.gridLine(settled, 2)!.cells[0]!.from);
    } finally {
      f.destroy();
    }
  });
}

test("late alignment recovery excludes scaffold from a peer-deleted row", async () => {
  const f = await fixture("| Header |\n| --- |\n| deleted-row |\n| surviving-row |");
  const { own, peer } = f;
  try {
    await f.action(own, "colLeft");
    await own.history.undo();
    const before = Y.encodeStateVector(peer.doc);
    const table = T.findTables(peer.text.toString())[0]!;
    for (const change of T.deleteRow(table, 1).toReversed()) {
      if (change.to > change.from) peer.text.delete(change.from, change.to - change.from);
      if (change.insert) peer.text.insert(change.from, change.insert);
    }
    const rowDelete = Y.encodeStateAsUpdate(peer.doc, before);
    const oldCursor = peer.cursor;
    const alignmentBefore = Y.encodeStateVector(peer.doc);
    const surviving = T.findTables(peer.text.toString())[0]!;
    for (const change of T.setAlign(surviving, 0, "center").toReversed()) peer.text.insert(change.from, change.insert);
    const colon = captureTextAnchor(peer.text, peer.text.toString().indexOf(":"));
    const lateAlignment = Y.encodeStateAsUpdate(peer.doc, alignmentBefore);
    expect((await f.accept(peer, rowDelete, oldCursor)).status).toBe("accepted");
    expect((await f.accept(peer, lateAlignment, oldCursor)).status).toBe("recoveryRequired");
    expect(peer.recovery.at(-1)!.update).toEqual(lateAlignment);
    expect(peer.recovery.at(-1)!.text).toContain(":");
    expect(own.text.toString()).not.toContain("deleted-row");
    const settled = T.findTables(own.text.toString())[0]!;
    expect(T.rowCount(settled)).toBe(2);
    expect(settled.lines.map((line) => line.cells.length)).toEqual([1, 1, 1]);
    expect(settled.align).toEqual([null]);
    expect(resolveTextAnchor(peer.text, colon)).not.toBeNull();
  } finally {
    f.destroy();
  }
});

test("cleared history and deleted columns release per-receipt document observers", async () => {
  const f = await fixture();
  const { own, peer } = f;
  const registered = spyOn(own.doc, "on");
  const removed = spyOn(own.doc, "off");
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      await f.action(own, "colLeft");
      own.history.clear();
      await f.action(peer, "deleteCol", 0);
      peer.history.clear();
      expect(own.history.undoDepth()).toBe(0);
      expect(own.history.redoDepth()).toBe(0);
      expect(peer.history.undoDepth()).toBe(0);
      expect(own.text.toString()).toBe(SOURCE);
    }
    // Observe public listener registration, without inspecting Yjs internals.
    for (const event of ["afterTransaction", "destroy"] as const) {
      expect(
        registered.mock.calls.filter(([name]) => name === event).length - removed.mock.calls.filter(([name]) => name === event).length,
      ).toBe(0);
    }
  } finally {
    registered.mockRestore();
    removed.mockRestore();
    f.destroy();
  }
});

test("persisted history markers stay bounded across fresh editor client IDs", async () => {
  const f = await fixture();
  try {
    for (let session = 0; session < 4; session++) {
      await f.action(f.own, "colLeft");
      const doc = new Y.Doc();
      doc.clientID = 501 + session;
      const state = (await f.canonical()).state!;
      Y.applyUpdate(doc, state);
      const manager = new Y.UndoManager(doc.getText("codemirror"));
      const history = createSharedTextActionHistory(doc, manager);
      const event = f.events.at(-1)!;
      const action = history.begin(event.data.actionId!);
      history.apply(fromBase64(event.data.payload), event.data.actionId, event.cursor);
      await action.applied;
      history.dispose();
      manager.destroy();
      expect(doc.getMap("shared-text-history").size).toBe(0);
      doc.destroy();
    }
    expect(T.findTables((await f.canonical()).text!)[0]!.columns).toBe(5);
  } finally {
    f.destroy();
  }
});
