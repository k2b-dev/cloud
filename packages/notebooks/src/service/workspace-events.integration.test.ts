import { expect } from "bun:test";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";

const natsTest = testFor("nats");

natsTest(
  "a quiet notebook has a replay cursor, and stored hints stay small and readable by older replicas",
  async () => {
    const { createSync } = await import("@k2b/sync");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const connection = await connectTestNats({ ignoreClusterUpdates: true, name: "notebooks-workspace-events-test" });
    const sync = createSync({
      connection,
      namespace: testSyncNamespace("notebooks-workspace-events"),
      application: "notebooks",
      defaults: { replicas: 1 },
    });
    const abort = new AbortController();
    bindProcessSync(sync);
    try {
      const workspaceEvents = await import("./workspace-events");
      const notebookId = crypto.randomUUID();
      // The SSR baseline of a notebook without events must still let the
      // socket replay what happens between the page load and the subscribe.
      const cursor = await workspaceEvents.latestCursor({ notebookId });
      expect(cursor).toMatch(/^s6t\.[A-Za-z0-9_-]+\.\d+$/);

      const note = {
        id: crypto.randomUUID(),
        shortId: "abcdef",
        notebookId,
        parentId: null,
        title: "Long note",
        position: 0,
        hasChildren: false,
        yjsSnapshotAt: null,
        historyIncomplete: true,
        contentMd: "x".repeat(100_000),
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lockedAt: null,
      };
      await workspaceEvents.noteUpdated(note);
      await workspaceEvents.notebookUpdated({ id: notebookId });

      const events = workspaceEvents.live({ notebookId, after: cursor, signal: abort.signal })[Symbol.asyncIterator]();
      const next = async () => {
        const result = await events.next();
        if (result.done) throw new Error("Expected a retained workspace hint");
        return result.value.data;
      };
      // Readers refetch on every hint, so the event carries references only,
      // and a note above the topic payload limit still sends its hint.
      expect(await next()).toEqual({
        v: 1,
        type: "note.updated",
        notebookId,
        note: { id: note.id, shortId: note.shortId, historyIncomplete: true },
      });
      // Replicas from before reference-only events destructure `notebook`.
      expect(await next()).toEqual({ v: 1, type: "notebook.updated", notebookId, notebook: {} });
      await events.return?.();
    } finally {
      abort.abort();
      await sync.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      await connection.drain();
    }
  },
  30_000,
);
