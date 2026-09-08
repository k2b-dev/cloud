import { describe, expect, test } from "bun:test";
import {
  assessLegacyYjsCoverage,
  classifySyncKeys,
  compareLegacyCursors,
  legacyYjsHighWater,
  legacyYjsNoteId,
} from "./legacy-sync-inventory";

const scriptSource = await Bun.file(new URL("./legacy-sync-inventory.ts", import.meta.url)).text();

describe("read-only legacy Sync inventory", () => {
  test("contains no Redis or Postgres mutation commands", () => {
    expect(scriptSource).not.toMatch(/redis\.send\("(?:DEL|FLUSHDB|FLUSHALL|SET|HSET|XADD|ZADD)"/);
    expect(scriptSource).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\b/);
  });
  test("keeps v5, older, scheduler and ephemeral keys distinct without deeming them disposable", () => {
    const result = classifySyncKeys([
      "sync:queue:namespace:v2:tenant:jobs:ready",
      "sync:job:enqueue-receipt:v2:tenant",
      "sync:job:mail:seq",
      "sync:queue:tenant:jobs:ready",
      "sync:job:mail:idempotency:message-1",
      "cloud:notebooks:default:snapshots:ready",
      "sync:scheduler:tenant:jobs:definitions",
      "sync:e:default:cloud-apps:state",
    ]);
    expect(result.currentDurable).toHaveLength(3);
    expect(result.legacyDurable).toHaveLength(3);
    expect(result.preservedScheduler).toHaveLength(1);
    expect(result.nonDurable).toHaveLength(1);
  });
  test("decodes only durable notebook document topics, excluding awareness and queue keys", () => {
    const key = (prefix: string) => `sync:topic:namespace:v2:${encodeURIComponent(JSON.stringify([prefix, "default", "note-id"]))}:stream`;
    expect(legacyYjsNoteId(key("cloud:notebooks:yjs"))).toBe("note-id");
    expect(legacyYjsNoteId(key("cloud:notebooks:yjs-awareness"))).toBeNull();
    expect(legacyYjsNoteId("sync:queue:namespace:v2:other:ready")).toBeNull();
  });
  test("reads Redis stream high-water even after the last retained entry was trimmed", () => {
    expect(legacyYjsHighWater(["length", 0, "last-generated-id", "100-2"])).toBe("100-2");
    expect(legacyYjsHighWater({ length: 0, "last-generated-id": "100-2" })).toBe("100-2");
    expect(() => legacyYjsHighWater({ length: 0 })).toThrow();
  });
  test("compares Redis cursor integers without Number precision loss", () => {
    expect(compareLegacyCursors("9007199254740993-1", "9007199254740992-999")).toBe(1);
    expect(compareLegacyCursors("100-2", "100-10")).toBe(-1);
    expect(() => compareLegacyCursors("s6t.hash.42", "100-1")).toThrow();
  });
  test("requires a covering nonempty Postgres snapshot and reports deleted-note streams separately", () => {
    const noteId = "0f8f1c2e-6c1a-4f6e-9b6c-2f1d3a4b5c6d";
    const note = { id: noteId, cursor: "100-2", snapshotBytes: 10 };
    expect(assessLegacyYjsCoverage(noteId, "100-2", note).status).toBe("covered");
    expect(assessLegacyYjsCoverage(noteId, "100-3", note).status).toBe("snapshot_required");
    expect(assessLegacyYjsCoverage(noteId, "100-2", { ...note, snapshotBytes: 0 }).status).toBe("snapshot_required");
    expect(assessLegacyYjsCoverage("7d2a9e4c-3b1f-4c8d-a2e5-6f7b8c9d0e1f", "100-2").status).toBe("deleted_note");
  });
  test("blocks on a v5 snapshot saved without a stream cursor instead of crashing", () => {
    const noteId = "0f8f1c2e-6c1a-4f6e-9b6c-2f1d3a4b5c6d";
    const result = assessLegacyYjsCoverage(noteId, "100-2", { id: noteId, cursor: null, snapshotBytes: 10 });
    expect(result).toEqual({ noteId, head: "100-2", snapshotCursor: null, status: "snapshot_required" });
  });
  test("reports a non-UUID note id as a row instead of aborting the Postgres lookup", () => {
    expect(assessLegacyYjsCoverage("not-a-uuid", "100-2").status).toBe("invalid_note_id");
    expect(assessLegacyYjsCoverage("not-a-uuid", "100-2", { id: "not-a-uuid", cursor: "100-2", snapshotBytes: 10 }).status).toBe(
      "invalid_note_id",
    );
  });
});
