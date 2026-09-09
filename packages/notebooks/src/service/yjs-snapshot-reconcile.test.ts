import { expect, test } from "bun:test";

// Isolate module stubs from the package's real PostgreSQL/NATS integration seams.
test("snapshot reconciliation visits every bounded page, heartbeats and honours cancellation", async () => {
  const fixture = `
    import { mock, expect } from "bun:test";
    let pages = [];
    let queued = [];
    let heartbeats = 0;
    const rows = Array.from({ length: 5001 }, (_, i) => ({ noteId: String(i).padStart(5, "0"), streamCursor: i === 5000 ? null : "s6t.fixture.1" }));
    mock.module("@k2b/cloud", () => ({ lazySync: () => () => ({ submit: async input => queued.push(input) }) }));
    mock.module("@k2b/cloud/services", () => ({ logger: () => ({ info() {}, debug() {}, error() {}, warn() {} }) }));
    mock.module("./notes", () => ({ listSnapshotCursors: async ({ limit, after }) => {
      pages.push({ limit, after });
      return rows.filter(row => !after || row.noteId > after).slice(0, limit);
    } }));
    mock.module("./yjs-sync", () => ({
      TOPIC_RETENTION_MS: 1000, NODE_ID: "fixture", MalformedSyncEventError: class extends Error {},
      applyYjsTopicEvent() {}, compareStreamCursor: (a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]),
      createYjsTopic: id => ({ latestCursor: async () => id === "05000" ? "s6t.fixture.2" : "s6t.fixture.1", cursorSequence: () => 2 })
    }));
    const { yjsSnapshotWorker, SNAPSHOT_JOB_CONFIG } = await import("./yjs-snapshot-worker");
    expect(SNAPSHOT_JOB_CONFIG.dedupeWindowMs).toBe(86400000);
    expect(await yjsSnapshotWorker.reconcile({ heartbeat: async () => { heartbeats++; } })).toEqual({ checked: 5001, queued: 1 });
    expect(pages).toEqual([{ limit: 5000, after: undefined }, { limit: 5000, after: "04999" }]);
    expect(queued[0].input.noteId).toBe("05000");
    expect(heartbeats).toBe(26);
    const abort = new AbortController();
    await expect(yjsSnapshotWorker.reconcile({ signal: abort.signal, heartbeat: async () => abort.abort() })).rejects.toThrow();
  `;
  const child = Bun.spawn([process.execPath, "--eval", fixture], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: code === 0 ? "passed" : out + err }).toEqual({ code: 0, output: "passed" });
});
