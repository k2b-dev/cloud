import { expect, spyOn } from "bun:test";
import { bindProcessSync, sql, unbindProcessSync } from "@k2b/cloud";
import type { SharedTextProviderPendingState } from "@k2b/cloud/browser/shared-text";
import { fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import { ConflictError, createSync } from "@k2b/sync";
import type { ServerWebSocket } from "bun";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { createYjsProvider } from "../frontend/lib/yjs/provider";
import { notebooksYjs } from "../lib/yjs";

/** The provider and application admission/store are real. Device bytes are captured at
 * onLocalUpdate here; offline.browser.test.ts verifies that boundary with real IndexedDB. */
for (const withHttpEdit of [false, true])
  testFor("database", "nats", "valkey")(
    `continuous Notebook typing survives a socket drop and a fresh provider (concurrent HTTP edit: ${withHttpEdit})`,
    async () => {
      const database = await useFreshDatabase("notebook_offline_input");
      let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
      let bound = false;
      let typing: Promise<void> | undefined;
      let work = Promise.resolve();
      let server: ReturnType<typeof Bun.serve> | undefined;
      let notify: ReturnType<typeof spyOn> | undefined;
      const clients: Array<{ provider: ReturnType<typeof createYjsProvider>; doc: Y.Doc; awareness: Awareness }> = [];
      try {
        connection = await connectTestNats();
        const sync = createSync({
          connection,
          namespace: testSyncNamespace("notebook-offline"),
          application: "notebooks",
          defaults: { replicas: 1 },
        });
        bindProcessSync(sync);
        bound = true;
        await sql`CREATE SCHEMA auth`.simple();
        await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
        await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
        const { migrate } = await import("../migrate");
        await migrate();
        const workspace = await import("./workspace-events");
        notify = spyOn(workspace, "noteUpdated").mockResolvedValue(undefined);
        const notes = await import("./notes");
        const { createYjsTopic } = await import("./yjs-sync");
        const noteId = crypto.randomUUID();
        const notebookId = crypto.randomUUID();
        await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, 'OffBk1', 'Offline input fixture')`;
        await sql`INSERT INTO notebooks.notes(id, short_id, notebook_id, title, content_md, created_at)
      VALUES (${noteId}::uuid, 'OffNt1', ${notebookId}::uuid, 'Input', 'Saved\n', '2020-01-01')`;
        await notes.getAnchoredYjsState({ noteId });
        await sync.ready();
        let reject = false;
        const sockets = new Set<ServerWebSocket<undefined>>();
        const errors: unknown[] = [];
        const waiters = new Set<() => void>();
        const changed = () => {
          for (const wake of waiters) wake();
        };
        const deadline = AbortSignal.timeout(20_000);
        const until = async (check: () => boolean) => {
          while (!check()) {
            deadline.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
              const wake = () => {
                waiters.delete(wake);
                deadline.removeEventListener("abort", abort);
                resolve();
              };
              const abort = () => {
                waiters.delete(wake);
                reject(deadline.reason);
              };
              waiters.add(wake);
              deadline.addEventListener("abort", abort, { once: true });
            });
          }
          if (errors.length) throw new AggregateError(errors);
        };
        const send = (socket: ServerWebSocket<undefined>, type: string, payload: unknown) => socket.send(JSON.stringify({ type, payload }));
        server = Bun.serve<undefined>({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request, host) {
            if (new URL(request.url).pathname === "/api/notebooks/ws") {
              if (host.upgrade(request, { data: undefined })) return;
              return new Response("Upgrade failed", { status: 400 });
            }
            const result = await notes.editContent({ noteId, createdBy: null, data: await request.json() });
            if (result.ok) {
              const fresh = await notes.noteDocuments.read(noteId);
              for (const socket of sockets)
                send(socket, notebooksYjs.wsType.syncPush, {
                  noteId: "OffNt1",
                  updates: [{ payload: toBase64(fresh!.state!), cursor: fresh!.cursor, restoreRevision: "0" }],
                });
            }
            return Response.json(result);
          },
          websocket: {
            open(socket) {
              sockets.add(socket);
            },
            close(socket) {
              sockets.delete(socket);
              changed();
            },
            message(socket, raw) {
              const packet = JSON.parse(String(raw));
              work = work
                .then(async () => {
                  if (packet.type === notebooksYjs.wsType.replayRequest) {
                    const stored = await notes.getAnchoredYjsState({ noteId });
                    const fresh = await notes.noteDocuments.read(noteId);
                    send(socket, notebooksYjs.wsType.syncPush, {
                      noteId: "OffNt1",
                      snapshot: true,
                      restoreRevision: "0",
                      updates: [{ payload: toBase64(stored!.yjsState!), cursor: stored!.streamCursor }],
                    });
                    send(socket, notebooksYjs.wsType.syncPush, {
                      noteId: "OffNt1",
                      restoreRevision: "0",
                      updates: [{ payload: toBase64(fresh!.state!), cursor: fresh!.cursor }],
                    });
                    send(socket, notebooksYjs.wsType.replayReady, { noteId: "OffNt1", restoreRevision: "0", cursor: fresh!.cursor });
                  } else if (packet.type === notebooksYjs.wsType.syncPublish && !reject) {
                    const result = await notes.acceptYjsUpdate({
                      noteId,
                      actor: { kind: "user", id: crypto.randomUUID() },
                      update: fromBase64(packet.payload.payload),
                      baseCursor: packet.payload.baseCursor,
                      restoreRevision: packet.payload.restoreRevision,
                      originNodeId: "offline-test",
                      originPeerId: null,
                    });
                    if (result.status === "accepted")
                      send(socket, notebooksYjs.wsType.syncPush, {
                        noteId: "OffNt1",
                        updates: [{ payload: packet.payload.payload, cursor: result.cursor, restoreRevision: "0" }],
                      });
                    else
                      send(socket, notebooksYjs.wsType.error, {
                        noteId: "OffNt1",
                        code: "RESYNC_REQUIRED",
                        reopen: true,
                        message: "Recover pending input",
                      });
                  }
                })
                .catch((error) => {
                  if (error instanceof ConflictError) {
                    send(socket, notebooksYjs.wsType.error, { noteId: "OffNt1", code: "STREAM_FAILED", message: "Replay changed head" });
                    socket.close(1012);
                  } else errors.push(error);
                })
                .finally(changed);
            },
          },
        });
        let device: SharedTextProviderPendingState | undefined;
        let ready = false;
        let ended = false;
        const open = async () => {
          const stored = await notes.getAnchoredYjsState({ noteId });
          const doc = new Y.Doc();
          Y.applyUpdate(doc, stored!.yjsState!);
          const awareness = new Awareness(doc);
          const provider = createYjsProvider({
            doc,
            awareness,
            noteId: "OffNt1",
            appUrl: server!.url.href,
            initialRestoreRevision: "0",
            initialCursor: device ? device.baseCursor : stored!.streamCursor,
            initialPending: device,
            onLocalUpdate: (pending) => {
              device = pending;
              changed();
            },
            onReady: () => {
              ready = true;
              changed();
            },
            onConnectionChange: (connected) => {
              if (!connected) ready = false;
              changed();
            },
            onFatal: () => {
              ended = true;
              changed();
            },
            onUnsentChange: changed,
          });
          clients.push({ provider, doc, awareness });
          provider.connect();
          await until(() => ready || ended || errors.length > 0);
          return { provider, text: doc.getText("codemirror") };
        };
        const first = await open();
        const typed = Array.from({ length: 400 }, (_, i) => String.fromCharCode(0x400 + i)).join("");
        const milestones = new Map<number, () => void>();
        const at = (index: number) => new Promise<void>((resolve) => milestones.set(index, resolve));
        const dropped = at(80),
          edited = at(160),
          restored = at(240),
          discarded = at(320);
        typing = (async () => {
          for (let i = 0; i < typed.length; i++) {
            first.text.insert(first.text.length, typed[i]!);
            milestones.get(i)?.();
            // This is input pacing, not a wait for an assertion: 400 keystrokes over two seconds.
            await Bun.sleep(5);
          }
        })();
        await dropped;
        reject = true;
        for (const socket of sockets) socket.close(1012);
        await edited;
        if (withHttpEdit) {
          const response = await fetch(new URL("/edit", server.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operations: [{ kind: "prepend", content: "HTTP edit\n" }] }),
          });
          expect(response.ok).toBe(true);
          expect(await response.json()).toMatchObject({ ok: true });
        }
        await restored;
        reject = false;
        first.provider.reconnectNow();
        await discarded;
        reject = true;
        for (const socket of sockets) socket.close(1012);
        await typing;
        await work;
        expect(first.provider.hasUnsentChanges()).toBe(true);
        expect(ended).toBe(false);
        // The final characters were never accepted by the server. A fresh provider
        // must recover their full state and original cursor; the old tab is gone.
        expect(device).toBeDefined();
        first.provider.dispose();
        reject = false;
        ready = false;
        const reopened = await open();
        await until(() => !reopened.provider.hasUnsentChanges() || ended || errors.length > 0);
        expect(ended).toBe(false);
        const fresh = await notes.noteDocuments.read(noteId);
        expect(fresh!.text).toBe(`${withHttpEdit ? "HTTP edit\n\n\n" : ""}Saved\n${typed}`);
        expect(
          (
            await notes.save({
              noteId,
              yjsState: fresh!.state!,
              contentMd: fresh!.text!,
              streamCursor: fresh!.cursor,
              restoreRevision: "0",
              createdBy: null,
              createVersion: true,
            })
          ).ok,
        ).toBe(true);
        const [row] = await sql<
          { content_md: string; yjs_snapshot: Uint8Array }[]
        >`SELECT content_md, yjs_snapshot FROM notebooks.notes WHERE id = ${noteId}::uuid`;
        expect(row!.content_md).toBe(`${withHttpEdit ? "HTTP edit\n\n\n" : ""}Saved\n${typed}`);
        const snapshot = new Y.Doc();
        try {
          Y.applyUpdate(snapshot, row!.yjs_snapshot);
          expect(snapshot.getText("codemirror").toString()).toBe(row!.content_md);
        } finally {
          snapshot.destroy();
        }

        // The ingress validator must explicitly offer stale table input, never accept or silently drop it.
        reopened.provider.dispose();
        ready = false;
        device = undefined;
        const table = "| A | B |\n| --- | --- |\n| value | tail |\n";
        expect(
          (await notes.editContent({ noteId, createdBy: null, data: { operations: [{ kind: "set-content", content: table }] } })).ok,
        ).toBe(true);
        const tableClient = await open();
        reject = true;
        tableClient.text.insert(table.indexOf("value") + "value".length, " UNSENT");
        const pendingText = tableClient.text.toString();
        expect(
          (
            await notes.editContent({
              noteId,
              createdBy: null,
              data: { operations: [{ kind: "set-content", content: "Table was replaced" }] },
            })
          ).ok,
        ).toBe(true);
        for (const socket of sockets) socket.close(1012);
        await until(() => !ready);
        reject = false;
        tableClient.provider.reconnectNow();
        await until(() => ended || errors.length > 0);
        expect(ended).toBe(true);
        tableClient.provider.dispose();
        expect(device!.text).toBe(pendingText);
        const copiedDevice = device!;
        ready = false;
        ended = false;
        await open();
        await until(() => ended || errors.length > 0);
        expect(ended).toBe(true);
        expect(device!.text).toBe(copiedDevice.text);
        expect(device!.text).toContain(" UNSENT");
        await work;
        expect(errors).toEqual([]);
        expect(await createYjsTopic().latestCursor({ tenantId: noteId })).toBeTruthy();
      } finally {
        await typing;
        for (const client of clients) {
          client.provider.dispose();
          client.awareness.destroy();
          client.doc.destroy();
        }
        server?.stop(true);
        await work;
        notify?.mockRestore();
        if (bound) unbindProcessSync();
        await connection?.close();
        await database.drop();
      }
    },
    30_000,
  );
