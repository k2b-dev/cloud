import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";
import { createDoc } from "../src/shared-text/documents";

// Original RED counterexample (kept in undo-durable-focused.log): raw receipt
// Undo -> author closes -> server Y.applyUpdate(undone), Y.applyUpdate(late),
// string-only repairTables. Input became a neighboring cell; alignment broke
// the separator. This fixture now exercises the production admission/inverse
// writer, reloading durable state for each operation, with no global Yjs hook.
for (const lateChange of ["input", "alignment"] as const) {
  for (const confirmed of [false, true])
    test(`retained column survives closed author and late peer ${lateChange} (${confirmed ? "confirmed" : "recoverable unconfirmed"})`, async () => {
      const f = createStructuralFixture();
      try {
        await f.action(f.own, "colLeft");
        const peerBefore = Y.encodeStateVector(f.peer.doc),
          baseCursor = f.peer.cursor;
        const table = T.findTables(f.peer.text.toString())[0]!;
        if (lateChange === "input") f.peer.text.insert(T.gridLine(table, 1)!.cells[0]!.from, "peer input");
        else for (const change of T.setAlign(table, 0, "center").toReversed()) f.peer.text.insert(change.from, change.insert);
        const delayed = Y.encodeStateAsUpdate(f.peer.doc, peerBefore),
          originalText = f.peer.text.toString();
        if (confirmed) expect((await f.accept(f.peer, delayed, baseCursor)).status).toBe("accepted");
        await f.own.history.undo();
        f.own.history.dispose();
        f.own.manager.destroy();
        f.own.doc.destroy();
        const reloaded = createDoc(f.stored());
        try {
          expect(reloaded.getText("codemirror").toString()).toBe(f.stored().text!);
        } finally {
          reloaded.destroy();
        }
        if (!confirmed) {
          const eventCount = f.events.length;
          expect((await f.accept(f.peer, delayed, baseCursor)).status).toBe("recoveryRequired");
          expect(f.events).toHaveLength(eventCount);
          expect(f.peer.recovery.at(-1)!.update).toEqual(delayed);
          // The pending source remains visible and unacknowledged. It is never
          // replaced with a falsely confirmed one-column projection.
          expect(originalText).toContain(lateChange === "input" ? "peer input" : ":---:");
          expect(f.peer.recovery.at(-1)!.text).toContain(lateChange === "input" ? "peer input" : ":");
        }
        const settled = (await f.canonical()).text!;
        expect(T.inspectTableStructure(settled)).toEqual({ extraCells: false, missingSeparator: false });
        const canonical = T.findTables(settled)[0]!;
        expect(canonical).toBeDefined();
        if (confirmed) {
          expect(canonical.columns).toBe(2);
          if (lateChange === "input") expect(T.gridLine(canonical, 1)!.cells[0]!.text).toBe("peer input");
          else expect(canonical.align[0]).toBe("center");
          expect(T.gridLine(canonical, 1)!.cells[1]!.text).toBe("Original");
        } else {
          expect(T.gridLine(canonical, 1)!.cells[0]!.text).toBe("Original");
          expect(settled).not.toContain("peer input");
        }
      } finally {
        f.destroy();
      }
    });
}
