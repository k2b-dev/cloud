import { expect, spyOn, test } from "bun:test";
import { captureTableAction, captureTextAnchor, fromBase64, resolveTextAnchor, SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import { findTables } from "@k2b/ui/text-editor/model";
import { sql } from "bun";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";

// Real persistence/attribution coverage. Run only with the established explicit
// test targets and heavy-test lock; the focused unit suites do not run this file.
if (process.env.NOTEBOOKS_TABLE_ACTION_INTEGRATION_CHILD !== "1") {
  testFor("database", "nats")("table actions preserve note identities, projections and service-account attribution", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_TABLE_ACTION_INTEGRATION_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  test("tableAction credits the actor in the real log, version and activity", async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const { migrate } = await import("../migrate");
    const notes = await import("./notes");
    const { createYjsTopic } = await import("./yjs-sync");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-table-actions");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const notebookId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const actor = { kind: "service_account" as const, id: crypto.randomUUID() };
    const actionId = crypto.randomUUID();
    const requestedAt = 1_790_000_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(requestedAt);
    const doc = new Y.Doc();
    doc.clientID = 100;
    const text = doc.getText(SHARED_TEXT_NAME);
    text.insert(0, "# Test\n\n| A | B |\n| --- | --- |\n| a | b |\n");
    const table = findTables(text.toString())[0]!;
    const intent = captureTableAction(text, "colRight", {
      tableFrom: table.from,
      rowFrom: table.lines[0]!.from,
      columnFrom: table.lines[0]!.cells[0]!.from,
      row: 0,
      column: 0,
    });
    const untouched = captureTextAnchor(text, text.toString().indexOf("b |"));
    try {
      await sync.ready();
      await migrate();
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name)
        VALUES (${notebookId}::uuid, ${testShortId()}, 'Table actions')`;
      await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, yjs_snapshot, content_md)
        VALUES (${noteId}::uuid, ${testShortId()}, ${notebookId}::uuid, 'Test', ${Buffer.from(Y.encodeStateAsUpdate(doc))}, ${text.toString()})`;
      const result = await notes.tableAction({
        notebookId,
        noteId,
        permission: "write",
        actor,
        createdBy: null,
        actionId,
        restoreRevision: "0",
        intent,
      });
      expect(result).toMatchObject({ ok: true, data: { changed: true, receipt: { actionId } } });
      if (!result.ok || !result.data.receipt) throw new Error("Missing accepted action receipt");
      Y.applyUpdate(doc, fromBase64(result.data.receipt.update));
      const at = resolveTextAnchor(text, untouched);
      expect(at).not.toBeNull();
      expect(text.toString()[at!]).toBe("b");
      expect(findTables(text.toString())[0]!.lines[0]!.cells.map((cell) => cell.text)).toEqual(["A", "", "B"]);
      const persisted = await notes.getCurrentWithContent({ id: noteId });
      expect(persisted?.contentMd).toBe(text.toString());
      expect(persisted?.title).toBe("Test");
      const topic = createYjsTopic();
      const latest = await topic.latestCursor({ tenantId: noteId });
      const events = await Array.fromAsync(topic.replay({ tenantId: noteId, after: topic.cursorAt(0), until: latest! }));
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({ actor, actionId });
      const contributors = await sql<{ actor_kind: string; actor_id: string; created_by: string | null }[]>`
        SELECT contributor.actor_kind, contributor.actor_id, version.created_by
        FROM notebooks.note_version_contributors contributor
        JOIN notebooks.note_versions version ON version.id = contributor.version_id
        WHERE version.note_id = ${noteId}::uuid
      `;
      expect(contributors).toEqual([{ actor_kind: "service_account", actor_id: actor.id, created_by: null }]);
      const activities = await sql<{ actor_kind: string; actor_id: string; last_occurred_at: Date }[]>`
        SELECT actor_kind, actor_id, last_occurred_at FROM notebooks.activity_events
        WHERE note_id = ${noteId}::uuid AND action = 'note.edited'
      `;
      expect(activities).toEqual([{ actor_kind: "service_account", actor_id: actor.id, last_occurred_at: new Date(requestedAt) }]);
    } finally {
      doc.destroy();
      clock.mockRestore();
      try {
        await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
        await sync.drain();
        const manager = await jetstreamManager(connection);
        for await (const stream of manager.streams.list())
          if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      } finally {
        unbindProcessSync();
        await connection.close();
      }
    }
  });
}
