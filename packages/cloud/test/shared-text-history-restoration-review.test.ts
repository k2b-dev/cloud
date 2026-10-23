import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createStructuralFixture } from "../src/shared-text/structural-history.test-fixture";

test("a held deletion is not falsely confirmed after a peer deletes and restores its column", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    const base = f.peer.cursor;
    const vector = Y.encodeStateVector(f.peer.doc);
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    const original = f.peer.text.toString();
    const delta = Y.encodeStateAsUpdate(f.peer.doc, vector);
    expect(Y.decodeUpdate(delta).structs).toHaveLength(0);
    await f.action(f.own, "deleteCol", 0, false);
    await f.own.history.undo();
    const before = (await f.canonical()).text;
    const count = f.events.length;
    expect(before).toContain("| x | y |");
    expect((await f.accept(f.peer, delta, base)).status).toBe("recoveryRequired");
    expect(f.events).toHaveLength(count);
    expect((await f.canonical()).text).toBe(before);
    expect(f.peer.recovery.at(-1)).toEqual({ update: delta, text: original, baseCursor: base });
  } finally {
    f.destroy();
  }
});

for (const delivered of [false, true])
  test(`restored column deletion provenance survives additional cycles and peer receipt delivery=${delivered}`, async () => {
    const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
    try {
      const base = f.peer.cursor,
        vector = Y.encodeStateVector(f.peer.doc);
      f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
      const delta = Y.encodeStateAsUpdate(f.peer.doc, vector);
      await f.action(f.own, "deleteCol", 0, false);
      await f.own.history.undo();
      await f.own.history.redo();
      await f.own.history.undo();
      if (delivered) f.deliver(f.peer);
      const before = (await f.canonical()).text,
        count = f.events.length;
      expect((await f.accept(f.peer, delta, base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(count);
      expect((await f.canonical()).text).toBe(before);
      expect(f.peer.recovery.at(-1)?.update).toEqual(delta);
      expect(f.peer.recovery.at(-1)?.baseCursor).toBe(base);
    } finally {
      f.destroy();
    }
  });

test("a confirmed deletion remains retryable after its empty column is deleted and restored", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    const base = f.peer.cursor,
      vector = Y.encodeStateVector(f.peer.doc);
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    const delta = Y.encodeStateAsUpdate(f.peer.doc, vector);
    expect((await f.accept(f.peer, delta, base)).status).toBe("accepted");
    await f.action(f.own, "deleteCol", 0);
    await f.own.history.undo();
    expect((await f.accept(f.peer, delta, base)).status).toBe("accepted");
    expect((await f.canonical()).text).not.toContain("| x | y |");
  } finally {
    f.destroy();
  }
});
