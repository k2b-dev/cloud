import { expect, spyOn, test } from "bun:test";
import {
  captureTableAction,
  captureTableFocus,
  captureTextAnchor,
  fromBase64,
  resolveTableFocus,
  resolveTextAnchor,
  SHARED_TEXT_NAME,
} from "@k2b/cloud/shared-text";
import { findTables, gridLine, setAlign } from "@k2b/ui/text-editor/model";
import { sql } from "bun";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { decodeTableFocus } from "../lib/table-actions";

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
        focus: captureTableFocus(text, {
          tableFrom: table.from,
          rowFrom: table.lines[0]!.from,
          columnFrom: table.lines[0]!.cells[0]!.from,
          row: 0,
          column: 0,
        }),
      });
      expect(result).toMatchObject({ ok: true, data: { changed: true, receipt: { actionId } } });
      if (!result.ok || !result.data.receipt) throw new Error("Missing accepted action receipt");
      Y.applyUpdate(doc, fromBase64(result.data.receipt.update));
      expect(result.data.focus).toBeTruthy();
      expect(resolveTableFocus(text, decodeTableFocus(result.data.focus!))).toMatchObject({ row: 0, column: 1 });
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

      // Durable author/peer boundary: accepted peer input and alignment retain
      // their original inserted column even when the initiating tab closes.
      const peer = new Y.Doc();
      try {
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        const peerText = peer.getText(SHARED_TEXT_NAME);
        const peerVector = Y.encodeStateVector(peer);
        let peerTable = findTables(peerText.toString())[0]!;
        peerText.insert(gridLine(peerTable, 1)!.cells[1]!.from, "CONFIRMED");
        peerTable = findTables(peerText.toString())[0]!;
        for (const change of setAlign(peerTable, 1, "center").toReversed()) peerText.insert(change.from, change.insert);
        const peerActor = { kind: "service_account" as const, id: crypto.randomUUID() };
        const accepted = await notes.acceptYjsUpdate({
          noteId,
          actor: peerActor,
          update: Y.encodeStateAsUpdate(peer, peerVector),
          baseCursor: result.data.cursor,
          restoreRevision: "0",
          originNodeId: "integration-peer",
          originPeerId: "peer",
        });
        expect(accepted.status).toBe("accepted");
        const inverse = await notes.tableAction({
          notebookId,
          noteId,
          permission: "write",
          actor,
          createdBy: null,
          actionId: crypto.randomUUID(),
          restoreRevision: "0",
          intent: { action: "undo", receiptCursor: result.data.cursor! },
        });
        expect(inverse).toMatchObject({ ok: true, data: { changed: true } });
        doc.destroy(); // No author manager or document remains alive.
        const reloaded = await notes.getYjsStateWithCursor({ noteId });
        const reopened = new Y.Doc();
        try {
          Y.applyUpdate(reopened, reloaded!.yjsState!);
          const canonical = reopened.getText(SHARED_TEXT_NAME).toString();
          const retained = findTables(canonical)[0]!;
          expect(retained.columns).toBe(3);
          expect(gridLine(retained, 1)!.cells[1]!.text).toBe("CONFIRMED");
          expect(retained.lines[1]!.cells[1]!.text).toBe(":---:");
          const event = await Array.fromAsync(
            topic.replay({
              tenantId: noteId,
              after: accepted.status === "accepted" ? accepted.cursor : undefined,
              until: reloaded!.streamCursor!,
            }),
          );
          expect(event.at(-1)?.data.history).toMatchObject({ retained: true, inverseOf: result.data.cursor });

          // The original raw RED schedule kept a peer update until after Undo,
          // then applied it to the post-Undo Y.Text and mis-targeted its cells.
          // Production ingress must instead reject it with exact recovery data.
          const t = findTables(canonical)[0]!;
          const inserted = await notes.tableAction({
            notebookId,
            noteId,
            permission: "write",
            actor,
            createdBy: null,
            actionId: crypto.randomUUID(),
            restoreRevision: "0",
            intent: captureTableAction(reopened.getText(SHARED_TEXT_NAME), "colLeft", {
              tableFrom: t.from,
              rowFrom: t.lines[0]!.from,
              columnFrom: t.lines[0]!.cells[0]!.from,
              row: 0,
              column: 0,
            }),
          });
          if (!inserted.ok || !inserted.data.receipt) throw new Error("Missing inserted-column receipt");
          Y.applyUpdate(reopened, fromBase64(inserted.data.receipt.update));
          const late = new Y.Doc();
          try {
            Y.applyUpdate(late, Y.encodeStateAsUpdate(reopened));
            const vector = Y.encodeStateVector(late),
              text = late.getText(SHARED_TEXT_NAME);
            text.insert(gridLine(findTables(text.toString())[0]!, 1)!.cells[0]!.from, "UNCONFIRMED");
            const recovery = { update: Y.encodeStateAsUpdate(late, vector), text: text.toString(), baseCursor: inserted.data.cursor };
            const undone = await notes.tableAction({
              notebookId,
              noteId,
              permission: "write",
              actor,
              createdBy: null,
              actionId: crypto.randomUUID(),
              restoreRevision: "0",
              intent: { action: "undo", receiptCursor: inserted.data.cursor! },
            });
            expect(undone.ok).toBe(true);
            reopened.destroy();
            const before = await notes.getCurrentWithContent({ id: noteId });
            const head = await topic.latestCursor({ tenantId: noteId });
            expect(
              await notes.acceptYjsUpdate({
                noteId,
                actor: peerActor,
                update: recovery.update,
                baseCursor: recovery.baseCursor,
                restoreRevision: "0",
                originNodeId: "integration-peer",
                originPeerId: "peer",
              }),
            ).toEqual({ status: "recoveryRequired" });
            expect(await topic.latestCursor({ tenantId: noteId })).toBe(head);
            expect((await notes.getCurrentWithContent({ id: noteId }))?.contentMd).toBe(before?.contentMd);
            expect(recovery.text).toContain("UNCONFIRMED");
            expect(recovery.update).toEqual(Y.encodeStateAsUpdate(late, vector));
          } finally {
            late.destroy();
          }
        } finally {
          reopened.destroy();
        }
      } finally {
        peer.destroy();
      }
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
