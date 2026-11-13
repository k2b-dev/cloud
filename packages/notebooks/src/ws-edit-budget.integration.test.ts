import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { meterSql } from "../../../scripts/fixtures/sql-meter";
import { connectTestNats, testFor, testSyncNamespace } from "../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../scripts/fixtures/test-short-id";

const edits = 10;

// Auth admission spies must not replace middleware imported by another suite.
if (process.env.NOTEBOOKS_EDIT_BUDGET_CHILD !== "1") {
  testFor("database", "nats", "valkey")(
    "an edit on an open note stays within its statement budget",
    async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_EDIT_BUDGET_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(55_000),
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
  test("statements per edit", async () => {
    const meter = await meterSql();
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { websocket } = await import("hono/bun");
    const Y = await import("yjs");
    const editor: User = {
      id: crypto.randomUUID(),
      uid: `budget-${crypto.randomUUID()}`,
      displayName: "Editor",
      roles: [],
      provider: "local",
      profile: "user",
      givenname: "Edit",
      sn: "Or",
      mail: "editor@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    spyOn(server.auth, "requireRole").mockReturnValue(async (_c, next) => next());
    spyOn(server.auth.session, "resolveToken").mockImplementation(async () => "editor");
    // Session admission is stubbed; its own lookup is the session budget's concern. Note and permission queries are real.
    spyOn(server.auth.session, "authenticate").mockImplementation(async () => ({
      user: editor,
      data: { userId: editor.id, sid: "editor", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
    }));
    spyOn(server, "guardAppAccessSocket").mockImplementation(async (_c, _appId, events) => events);
    const { createAppEventTestHarness } = await import("@k2b/cloud/events/testing");
    const { notebooksCapabilities } = await import("./capabilities");
    createAppEventTestHarness("notebooks", notebooksCapabilities);
    const { migrate } = await import("./migrate");
    const { notebooksService } = await import("./service");
    const { default: app, drainNotebookConnections } = await import("./ws");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("edit-budget");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const notebookId = crypto.randomUUID();
    const grant = crypto.randomUUID();
    const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
    type Message = { type: string; payload: { cursor?: string } };
    const messages: Message[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${http.port}/`);
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    const waitFor = async (check: () => boolean, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check() && Date.now() < deadline) await Bun.sleep(5);
      expect(check()).toBe(true);
    };
    const pushes = () => messages.filter((m) => m.type === "notes.yjs.sync.push");
    const doc = new Y.Doc();
    try {
      await sync.ready();
      await migrate();
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${editor.id}::uuid, ${editor.uid}, 'local', 'user')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'Edit budget')`;
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${grant}::uuid, ${editor.id}::uuid, 'write')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${grant}::uuid)`;
      const created = await notebooksService.note.create({ data: { notebookId, contentMd: "# Budget\n" }, creatorId: editor.id });
      if (!created.ok) throw new Error(created.error);
      const note = created.data;
      await waitFor(() => socket.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: "notes.yjs.replay.request", payload: { noteId: note.shortId, restoreRevision: null } }));
      await waitFor(() => messages.some((m) => m.type === "notes.yjs.replay.ready"));
      const state = await notebooksService.note.getAnchoredYjsState({ noteId: note.id });
      if (state?.yjsState) Y.applyUpdate(doc, state.yjsState);
      let cursor = messages.find((m) => m.type === "notes.yjs.replay.ready")?.payload.cursor;
      const edit = async (index: number) => {
        const before = Y.encodeStateVector(doc);
        doc.getText("codemirror").insert(doc.getText("codemirror").length, String(index % 10));
        const seen = pushes().length;
        socket.send(
          JSON.stringify({
            type: "notes.yjs.sync.publish",
            payload: {
              noteId: note.shortId,
              payload: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
              restoreRevision: "0",
              baseCursor: cursor,
            },
          }),
        );
        await waitFor(() => pushes().length > seen);
        cursor = pushes().at(-1)?.payload.cursor ?? cursor;
      };
      await edit(0);
      const statements = await meter.during(async () => {
        for (let index = 1; index <= edits; index++) await edit(index);
      });
      expect(messages.filter((m) => m.type === "notes.yjs.error")).toEqual([]);
      // Today: two snapshot reads, three access queries and a row-locked delivery per edit.
      // The target is none (#3231, #3232): a fix lowers this number, and nothing may raise it.
      expect({ perEdit: statements.length / edits, statements }).toEqual({ perEdit: 8, statements: expect.any(Array) });
    } finally {
      doc.destroy();
      socket.close();
      await drainNotebookConnections();
      await http.stop(true);
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${grant}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${editor.id}::uuid`;
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
      await meter.close();
    }
  }, 45_000);
}
