import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";

for (const restore of ["escape", "letter"] as const) {
  test(`native ${restore} restoration preserves peer cell even when both neighbors survive`, async () => {
    const slash = String.fromCharCode(92);
    const f = createStructuralFixture(`| A | B |\n| --- | --- |\n| q${restore === "letter" ? `${slash}x` : ""}| r |`);
    try {
      if (restore === "escape") {
        f.own.text.insert(f.own.text.toString().indexOf("q|") + 1, slash);
        expect((await f.accept(f.own)).status).toBe("accepted");
        await f.own.history.undo();
      } else {
        f.own.text.delete(f.own.text.toString().indexOf("x"), 1);
      }
      expect((await f.accept(f.own)).status).toBe("accepted");
      f.peer.text.insert(f.peer.text.toString().indexOf("r") + 1, "PEER");
      expect((await f.accept(f.peer)).status).toBe("accepted");
      const before = f.own.text.toString();
      const undoDepth = f.own.history.undoDepth();
      const redoDepth = f.own.history.redoDepth();
      const publications = f.events.length;
      const column = restore === "letter" ? 0 : 1;
      expect(T.gridLine(T.findTables(before)[0]!, 1)!.cells[column]!.text).toContain("PEER");
      try {
        await (restore === "escape" ? f.own.history.redo() : f.own.history.undo());
      } catch (error) {
        expect(String(error)).toContain("The input history target is unavailable");
        expect(f.own.text.toString()).toBe(before);
        expect(f.own.history.undoDepth()).toBe(undoDepth);
        expect(f.own.history.redoDepth()).toBe(redoDepth);
        expect(f.events).toHaveLength(publications);
        expect((await f.canonical()).text).toBe(before);
        return;
      }
      expect((await f.accept(f.own)).status).toBe("accepted");
      expect(T.gridLine(T.findTables((await f.canonical()).text!)[0]!, 1)!.cells[column]?.text).toContain("PEER");
    } finally {
      f.destroy();
    }
  });
}
