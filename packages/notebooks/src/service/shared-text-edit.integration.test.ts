import { expect, spyOn, test } from "bun:test";
import { SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import { sql } from "bun";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";

// Isolate the notes module's default SQL handle and process Sync binding.
if (process.env.NOTEBOOKS_SHARED_TEXT_EDIT_CHILD !== "1") {
  testFor("database", "nats")(
    "shared text edits preserve attribution and unchanged anchors in Notebooks",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_SHARED_TEXT_EDIT_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    },
    60_000,
  );
} else {
  test("editContent credits a service account and restoring in place preserves unchanged anchors", async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const { migrate } = await import("../migrate");
    const notes = await import("./notes");
    const { createYjsTopic } = await import("./yjs-sync");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-shared-text-edit");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const notebookId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const actor = { kind: "service_account" as const, id: crypto.randomUUID() };
    const requestedAt = 1_790_000_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(requestedAt);
    try {
      await sync.ready();
      await migrate();
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name)
        VALUES (${notebookId}::uuid, ${testShortId()}, 'Shared text')`;
      await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title)
        VALUES (${noteId}::uuid, ${testShortId()}, ${notebookId}::uuid, '')`;
      const result = await notes.editContent({
        noteId,
        createdBy: null,
        actor,
        data: { operations: [{ kind: "set-content", content: "# Written by an agent\n" }] },
      });
      expect(result).toMatchObject({ ok: true, data: { content: "# Written by an agent\n", changed: true } });
      const topic = createYjsTopic();
      const latest = await topic.latestCursor({ tenantId: noteId });
      expect(latest).not.toBeNull();
      const events = await Array.fromAsync(topic.replay({ tenantId: noteId, after: topic.cursorAt(0), until: latest! }));
      expect(events).toHaveLength(1);
      expect(events[0]?.data.actor).toEqual(actor);
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

      const original = "First old paragraph\n\nMiddle stable 😀 paragraph\n\nThird old paragraph\n";
      expect(
        await notes.editContent({
          noteId,
          createdBy: null,
          actor,
          data: { operations: [{ kind: "set-content", content: original }] },
        }),
      ).toMatchObject({ ok: true });
      const [initial] = await sql<{ yjs_snapshot: Uint8Array }[]>`
        SELECT yjs_snapshot FROM notebooks.notes WHERE id = ${noteId}::uuid
      `;
      const versionId = crypto.randomUUID();
      await sql`INSERT INTO notebooks.note_versions (id, note_id, yjs_snapshot, content_md)
        VALUES (${versionId}::uuid, ${noteId}::uuid, ${Buffer.from(initial!.yjs_snapshot)}, ${original})`;
      const browser = new Y.Doc();
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(browser, initial!.yjs_snapshot);
        const anchor = Y.createRelativePositionFromTypeIndex(browser.getText(SHARED_TEXT_NAME), original.indexOf("stable"));
        expect(
          await notes.editContent({
            noteId,
            createdBy: null,
            actor,
            data: { operations: [{ kind: "set-content", content: original.replaceAll("old", "new longer") }] },
          }),
        ).toMatchObject({ ok: true });
        expect(await notes.restoreInPlace({ noteId, versionId, createdBy: null, actor })).toMatchObject({
          ok: true,
          data: { changed: true },
        });
        const [row] = await sql<{ yjs_snapshot: Uint8Array; content_md: string; yjs_restore_revision: string }[]>`
          SELECT yjs_snapshot, content_md, yjs_restore_revision::text FROM notebooks.notes WHERE id = ${noteId}::uuid
        `;
        Y.applyUpdate(restored, row!.yjs_snapshot);
        expect(row!.content_md).toBe(original);
        expect(row!.yjs_restore_revision).toBe("0");
        const restoredText = restored.getText(SHARED_TEXT_NAME);
        const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, restored, false);
        expect(resolved?.type === restoredText).toBe(true);
        expect(restoredText.toString().slice(resolved!.index, resolved!.index + "stable 😀".length)).toBe("stable 😀");
      } finally {
        browser.destroy();
        restored.destroy();
      }
    } finally {
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
  }, 30_000);
}
