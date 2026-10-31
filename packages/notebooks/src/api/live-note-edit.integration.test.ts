import { expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { Awareness } from "y-protocols/awareness";
import { connectTestNats, createMigratedDatabase, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";

/**
 * An agent reads and edits a note through the CLI's HTTP routes while the note
 * is open in the browser editor with edits that no snapshot covers yet. The
 * read must show the live content, so its hash is a valid edit precondition.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.NOTEBOOKS_LIVE_EDIT_CHILD !== "1") {
  testFor("database", "nats")(
    "the CLI reads and edits a note that is open in the editor",
    async () => {
      const database = await createMigratedDatabase("notebook_cli_live");
      try {
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: { ...process.env, DATABASE_URL: database.url, CLOUD_TEST_DATABASE_URL: database.url, NOTEBOOKS_LIVE_EDIT_CHILD: "1" },
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
  test("live read and conditional edit", async () => {
    const Y = await import("yjs");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("../migrate");
    const { notebooksService } = await import("../service");
    const { createYjsProvider } = await import("../frontend/lib/yjs/provider");
    const { yjsSnapshotWorker } = await import("../service/yjs-snapshot-worker");
    const { drainNotebookConnections } = await import("../ws");
    spyOn(yjsSnapshotWorker, "queueSnapshotSave").mockResolvedValue(undefined);
    spyOn(server, "guardAppAccessSocket").mockImplementation(async (_c, _appId, events) => events);
    const { noteContentHash } = await import("../lib/note-edit");
    const { default: app } = await import("./index");

    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-live-edit");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const user: User = {
      id: crypto.randomUUID(),
      uid: `live-edit-${crypto.randomUUID().slice(0, 8)}`,
      roles: ["admin"],
      provider: "local",
      profile: "user",
      givenname: "Live",
      sn: "Editor",
      displayName: "Live Editor",
      mail: "live-edit@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    const notebookId = crypto.randomUUID();
    const notebookShortId = testShortId();
    spyOn(server.auth.session, "resolveToken").mockResolvedValue("fixture-session");
    spyOn(server.auth.session, "authenticate").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "fixture-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
    });
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const http = new Hono().route("/api/notebooks", app);
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: http.fetch, websocket });
    let provider: ReturnType<typeof createYjsProvider> | undefined;
    let holdDelivery = false;
    const deliveryHeld = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const deliver = notebooksService.note.deliverAtRestoreRevision;
    spyOn(notebooksService.note, "deliverAtRestoreRevision").mockImplementation(async (input) => {
      if (holdDelivery) {
        deliveryHeld.resolve();
        await releaseDelivery.promise;
      }
      return deliver(input);
    });
    const admissions: string[] = [];
    const accept = notebooksService.note.acceptYjsUpdate;
    spyOn(notebooksService.note, "acceptYjsUpdate").mockImplementation(async (input) => {
      const result = await accept(input);
      admissions.push(result.status);
      return result;
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 5_000;
      while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
      expect(predicate()).toBe(true);
    };
    try {
      await sync.ready();
      await migrate();
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Live edit')`;
      expect(
        await notebooksService.notebook.access.grant({ notebookId, principal: { type: "user", userId: user.id }, permission: "admin" }),
      ).toMatchObject({ ok: true });
      const created = await notebooksService.note.create({ data: { notebookId, contentMd: "# Plan\n\nfirst\n" }, creatorId: user.id });
      if (!created.ok) throw new Error(created.error);
      const noteId = created.data.id;
      const path = `/${notebookShortId}/notes/${created.data.shortId}/content`;
      const headers = { authorization: "Bearer live-edit", "content-type": "application/json" };
      const read = async () => {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(200);
        return (await response.json()) as { contentMd: string; yjsSnapshot: string; yjsRestoreRevision: string };
      };

      // Use the real WebSocket server, retained log and browser provider.
      const ready = Promise.withResolvers<void>();
      const errors: string[] = [];
      provider = createYjsProvider({
        doc,
        awareness,
        noteId: created.data.shortId,
        appUrl: listener.url.origin,
        onReady: () => ready.resolve(),
        onFatal: (error) => errors.push(error.code),
      });
      provider.connect();
      await Promise.race([ready.promise, Bun.sleep(5_000)]);
      const text = doc.getText("codemirror");
      expect(text.toString()).toBe("# Plan\n\nfirst\n");
      text.insert(text.length, "typed in browser\n");
      await waitFor(() => admissions.length === 1 && !provider!.hasUnsentChanges());
      expect(admissions).toEqual(["accepted"]);

      // `cld notebooks cat` sees the unsnapshotted edit, so its hash guards the next edit.
      const current = await read();
      expect(current.yjsRestoreRevision).toBe("0");
      expect(current.contentMd).toBe("# Plan\n\nfirst\ntyped in browser\n");
      const response = await app.request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          operations: [{ kind: "append", content: "from agent\n" }],
          ifContentHash: noteContentHash(current.contentMd),
        }),
      });
      expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { changed: true } });

      const expected = "# Plan\n\nfirst\ntyped in browser\nfrom agent\n";
      expect((await read()).contentMd).toBe(expected);
      await waitFor(() => text.toString() === expected);

      // Hold delivery of the CLI receipt so the simultaneous browser edit has
      // the preceding cursor. This is a transport race, not a stale whole-note save.
      holdDelivery = true;
      const concurrent = await app.request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ operations: [{ kind: "append", content: "concurrent CLI\n" }] }),
      });
      expect(concurrent.status).toBe(200);
      await Promise.race([deliveryHeld.promise, Bun.sleep(5_000)]);
      text.insert(0, "browser prefix\n");
      await waitFor(() => admissions.length === 2);
      holdDelivery = false;
      releaseDelivery.resolve();
      expect(admissions).toEqual(["accepted", "accepted"]);
      const merged = `browser prefix\n${expected}concurrent CLI\n`;
      await waitFor(() => text.toString() === merged && !provider!.hasUnsentChanges());
      expect((await read()).contentMd).toBe(merged);
      expect(errors).toEqual([]);

      // A later CLI save materializes both updates, rather than overwriting one.
      expect(
        (
          await app.request(path, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ operations: [{ kind: "append", content: "persisted\n" }] }),
          })
        ).status,
      ).toBe(200);
      const finalText = `${merged}persisted\n`;
      await waitFor(() => text.toString() === finalText);
      const [stored] = await sql<{ content_md: string; yjs_snapshot: Uint8Array }[]>`
        SELECT content_md, yjs_snapshot FROM notebooks.notes WHERE id = ${noteId}::uuid`;
      expect(stored!.content_md).toBe(finalText);
      const persisted = new Y.Doc();
      try {
        Y.applyUpdate(persisted, stored!.yjs_snapshot);
        expect(persisted.getText("codemirror").toString()).toBe(finalText);
      } finally {
        persisted.destroy();
      }
    } finally {
      releaseDelivery.resolve();
      provider?.dispose();
      await drainNotebookConnections();
      await listener.stop(true);
      awareness.destroy();
      doc.destroy();
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
