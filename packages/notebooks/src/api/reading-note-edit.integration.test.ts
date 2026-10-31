import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { captureTableAction, toBase64 } from "@k2b/cloud/shared-text";
import { findTables } from "@k2b/ui/text-editor/model";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import * as Y from "yjs";
import { connectTestNats, createMigratedDatabase, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import type { NoteEditOperation } from "../lib/note-edit";
import { notebooksWorkspace, type PublicNotebookWorkspaceEvent } from "../lib/workspace-events";
import type { NotebookRouteStateResponse } from "../service/route-state";

// Like a newly opened NoteEditor, this client has only a workspace socket:
// no Yjs provider, snapshot worker or debounced application-event sweep.
if (process.env.NOTEBOOKS_READING_EDIT_CHILD !== "1") {
  testFor("database", "nats")(
    "CLI writes reach an open note before its first edit",
    async () => {
      const database = await createMigratedDatabase("notebook_cli_reading");
      try {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: {
            ...process.env,
            DATABASE_URL: database.url,
            CLOUD_TEST_DATABASE_URL: database.url,
            NOTEBOOKS_READING_EDIT_CHILD: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
      } finally {
        await database.drop();
      }
    },
    180_000,
  );
} else {
  test("workspace hints cover committed saved text for every edit operation and direct saves", async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    spyOn(server, "guardAppAccessSocket").mockImplementation(async (_c, _appId, events) => events);
    const { notebooksService } = await import("../service");
    const { yjsSnapshotWorker } = await import("../service/yjs-snapshot-worker");
    const snapshots = spyOn(yjsSnapshotWorker, "queueSnapshotSave").mockResolvedValue(undefined);
    const { createYjsTopic } = await import("../service/yjs-sync");
    const { drainNotebookConnections } = await import("../ws");
    const { default: app } = await import("./index");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-reading-edit");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const user: User = {
      id: crypto.randomUUID(),
      uid: `reading-edit-${crypto.randomUUID().slice(0, 8)}`,
      roles: ["admin"],
      provider: "local",
      profile: "user",
      givenname: "Reading",
      sn: "Editor",
      displayName: "Reading Editor",
      mail: "reading-edit@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    // The socket and CLI deliberately have the same author: their updates must
    // still reach an idle editor in another tab belonging to that person.
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(server.auth.session, "resolveToken").mockResolvedValue("fixture-session");
    spyOn(server.auth.session, "authenticate").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "fixture-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
    });
    const notebookId = crypto.randomUUID();
    const notebookShortId = testShortId();
    const headers = { authorization: "Bearer reading-edit", "content-type": "application/json" };
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: new Hono().route("/api/notebooks", app).fetch,
      websocket,
    });
    let socket: WebSocket | undefined;
    let cursor: string | null = null;
    let pending: { shortId: string; expected: string; covered: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
    let reads = Promise.resolve();
    const readSavedText = async (shortId: string) => {
      const href = `/app/notebooks/${notebookShortId}/notes/${shortId}`;
      const response = await app.request(`/${notebookShortId}/route-state?${new URLSearchParams({ href })}`, { headers });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as NotebookRouteStateResponse;
      if (payload.kind !== "ok") throw new Error(`Unexpected route state: ${JSON.stringify(payload)}`);
      expect(payload.state.note.id).toBe(shortId);
      return payload.state.note.contentMd;
    };
    const withinBound = async (promise: Promise<void>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}: saved text was not covered within 5 seconds`)), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const connect = async () => {
      const ready = Promise.withResolvers<void>();
      const url = new URL("/api/notebooks/ws", listener.url);
      url.protocol = "ws:";
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () =>
        ws.send(
          JSON.stringify({ type: notebooksWorkspace.wsType.subscribe, payload: { notebookId: notebookShortId, fromCursor: cursor } }),
        );
      ws.onmessage = (message) => {
        const packet = JSON.parse(String(message.data)) as {
          type: string;
          payload: { notebookId: string; cursor: string; event: PublicNotebookWorkspaceEvent };
        };
        if (packet.type === notebooksWorkspace.wsType.ready) ready.resolve();
        if (packet.type !== notebooksWorkspace.wsType.event) return;
        const { event, cursor: receivedCursor } = packet.payload;
        const target = pending;
        if (event.type !== "note.updated" || event.note.id !== target?.shortId) return;
        reads = reads
          .then(async () => {
            expect(event.notebookId).toBe(notebookShortId);
            // Start the canonical read as soon as the hint arrives, even if
            // the HTTP write is still returning. No polling hides an old read.
            expect(await readSavedText(target.shortId)).toBe(target.expected);
            cursor = receivedCursor; // Same ordering as bridge cover() -> lastCursor.
            target.covered.resolve();
          })
          .catch(target.covered.reject);
      };
      await withinBound(ready.promise, "workspace subscribe");
    };
    const expectWrite = async (shortId: string, expected: string, write: () => Promise<void>, label: string) => {
      const covered = Promise.withResolvers<void>();
      pending = { shortId, expected, covered };
      // Attach the timeout/rejection observer before starting the writer.
      const observed = withinBound(covered.promise, label);
      await Promise.all([observed, write()]);
      pending = undefined;
    };
    const createNote = async (contentMd: string) => {
      const created = await notebooksService.note.create({ data: { notebookId, contentMd }, creatorId: user.id });
      if (!created.ok) throw new Error(created.error);
      expect(await readSavedText(created.data.shortId)).toBe(contentMd);
      return created.data;
    };
    try {
      await sync.ready();
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name, default_presentation_mode)
        VALUES (${notebookId}::uuid, ${notebookShortId}, 'Reading edits', 'write')`;
      expect(
        await notebooksService.notebook.access.grant({ notebookId, principal: { type: "user", userId: user.id }, permission: "admin" }),
      ).toMatchObject({ ok: true });
      cursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
      await connect();
      const cases: { label: string; before: string; operation: NoteEditOperation; after: string }[] = [
        { label: "write/replace", before: "# Old\n", operation: { kind: "set-content", content: "# New\n" }, after: "# New\n" },
        { label: "append", before: "# Note\n", operation: { kind: "append", content: "next" }, after: "# Note\nnext" },
        { label: "prepend", before: "body", operation: { kind: "prepend", content: "# Note" }, after: "# Note\n\nbody" },
        {
          label: "rename",
          before: "# Old\n\nbody",
          operation: { kind: "replace-lines", startLine: 1, endLine: 1, content: "# Renamed" },
          after: "# Renamed\n\nbody",
        },
        {
          label: "insert-before-line",
          before: "# Note\nbody",
          operation: { kind: "insert-before-line", line: 2, content: "before" },
          after: "# Note\nbefore\nbody",
        },
        {
          label: "insert-after-line",
          before: "# Note\nbody",
          operation: { kind: "insert-after-line", line: 1, content: "after" },
          after: "# Note\nafter\nbody",
        },
        {
          label: "delete-lines",
          before: "# Note\nremove\nkeep",
          operation: { kind: "delete-lines", startLine: 2, endLine: 2 },
          after: "# Note\nkeep",
        },
        {
          label: "frontmatter",
          before: "---\nstatus: old\n---\n# Note\n",
          operation: { kind: "replace-lines", startLine: 2, endLine: 2, content: "status: new" },
          after: "---\nstatus: new\n---\n# Note\n",
        },
        {
          label: "replace-block/table",
          before: "# Note\n\n@ideas\n| A | B |\n|---|---|\n| old | keep |\n",
          operation: { kind: "replace-block", name: "ideas", type: "table", content: "| A | B |\n|---|---|\n| new | keep |" },
          after: "# Note\n\n@ideas\n| A | B |\n|---|---|\n| new | keep |\n",
        },
        {
          label: "append-block",
          before: "# Note\n\n@log\n## Log\nold\n",
          operation: { kind: "append-block", name: "log", type: "section", content: "new" },
          after: "# Note\n\n@log\n## Log\nold\n\nnew",
        },
        {
          label: "prepend-block",
          before: "# Note\n\n@log\n## Log\nold\n",
          operation: { kind: "prepend-block", name: "log", type: "section", content: "new" },
          after: "# Note\n\n@log\nnew\n\n## Log\nold\n",
        },
      ];
      for (const item of cases) {
        const note = await createNote(item.before);
        await expectWrite(
          note.shortId,
          item.after,
          async () => {
            const response = await app.request(`/${notebookShortId}/notes/${note.shortId}/content`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({ operations: [item.operation] }),
            });
            expect({ label: item.label, status: response.status, body: await response.json() }).toMatchObject({
              label: item.label,
              status: 200,
              body: { changed: true, content: item.after },
            });
          },
          item.label,
        );
        expect(await createYjsTopic().latestCursor({ tenantId: note.id })).not.toBeNull();
      }

      const replayed = await createNote("# Replay\nold");
      const closed = Promise.withResolvers<void>();
      socket!.onclose = () => closed.resolve();
      socket!.close();
      await withinBound(closed.promise, "workspace disconnect");
      await expectWrite(
        replayed.shortId,
        "# Replay\nnew",
        async () => {
          const response = await app.request(`/${notebookShortId}/notes/${replayed.shortId}/content`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ operations: [{ kind: "set-content", content: "# Replay\nnew" }] }),
          });
          expect(response.status).toBe(200);
          // An edit between disconnect and subscribe replays after the last
          // cursor whose saved-text read completed, rather than being skipped.
          await connect();
        },
        "workspace reconnect replay",
      );

      const tableNote = await createNote("# Table\n\n| A | B |\n| --- | --- |\n| a | b |\n");
      // Anchor through the public content read, as a structural-action client does.
      const current = await app.request(`/${notebookShortId}/notes/${tableNote.shortId}/content`, { headers });
      const head = (await current.json()) as { yjsSnapshot: string; yjsRestoreRevision: string };
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Buffer.from(head.yjsSnapshot, "base64"));
        const text = doc.getText("codemirror");
        const table = findTables(text.toString())[0]!;
        const intent = captureTableAction(text, "alignCenter", {
          tableFrom: table.from,
          rowFrom: table.lines[0]!.from,
          columnFrom: table.lines[0]!.cells[0]!.from,
          row: 0,
          column: 0,
        });
        if (!("column" in intent)) throw new Error("Expected column action");
        await expectWrite(
          tableNote.shortId,
          "# Table\n\n| A | B |\n| :---: | --- |\n| a | b |\n",
          async () => {
            const response = await app.request(`/${notebookShortId}/notes/${tableNote.shortId}/table-action`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                actionId: crypto.randomUUID(),
                restoreRevision: head.yjsRestoreRevision,
                intent: {
                  action: intent.action,
                  table: { headerBreak: toBase64(intent.table.headerBreak), separatorHyphen: toBase64(intent.table.separatorHyphen) },
                  column: {
                    hyphen: toBase64(intent.column.hyphen),
                    left: toBase64(intent.column.left),
                    right: toBase64(intent.column.right),
                  },
                },
              }),
            });
            expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { changed: true } });
          },
          "anchored table action",
        );
      } finally {
        doc.destroy();
      }

      // Store-only Markdown/snapshot writes use the same post-commit hint,
      // without publishing a shared-text update (templates use this seam).
      const direct = await createNote("# Direct\nold");
      const directDoc = new Y.Doc();
      try {
        const after = "# Direct\nnew";
        directDoc.getText("codemirror").insert(0, after);
        const topic = createYjsTopic();
        const beforeCursor = await topic.latestCursor({ tenantId: direct.id });
        await expectWrite(
          direct.shortId,
          after,
          async () => {
            expect(
              await notebooksService.note.save({
                noteId: direct.id,
                contentMd: after,
                yjsState: Y.encodeStateAsUpdate(directDoc),
                createdBy: user.id,
              }),
            ).toMatchObject({ ok: true });
          },
          "direct Markdown save",
        );
        expect(await topic.latestCursor({ tenantId: direct.id })).toBe(beforeCursor);
      } finally {
        directDoc.destroy();
      }
      expect(snapshots).not.toHaveBeenCalled();
    } finally {
      socket?.close();
      await reads;
      await drainNotebookConnections();
      await listener.stop(true);
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  }, 30_000);
}
