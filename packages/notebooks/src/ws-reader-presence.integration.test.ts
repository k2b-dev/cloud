import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { NotebookPresenceParticipant, User } from "@k2b/cloud/contracts";
import { connectTestNats, testFor, testSyncNamespace } from "../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../scripts/fixtures/test-short-id";

// Auth admission spies must not replace middleware imported by another suite.
if (process.env.NOTEBOOKS_READER_PRESENCE_CHILD !== "1") {
  testFor("database", "nats", "valkey")(
    "readers and editors share opened-note presence without starting reader collaboration",
    async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_READER_PRESENCE_CHILD: "1" },
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
  test("reader lifecycle, collaboration takeover and permission boundaries", async () => {
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { websocket } = await import("hono/bun");
    const Y = await import("yjs");
    const user = (name: string): User => ({
      id: crypto.randomUUID(),
      uid: `presence-${crypto.randomUUID()}`,
      displayName: name,
      roles: [],
      provider: "local",
      profile: "user",
      givenname: name,
      sn: "Reader",
      mail: `${name}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    });
    const alice = user("Alice");
    const bob = user("Bob");
    const sessions = new Map([
      ["alice", alice],
      ["bob", bob],
    ]);
    spyOn(server.auth, "requireRole").mockReturnValue(async (_c, next) => next());
    spyOn(server.auth.session, "resolveToken").mockImplementation(async (c) => c.req.query("testSession") ?? null);
    // Only session admission is stubbed: notebook/note permission queries and all presence I/O are real.
    spyOn(server.auth.session, "authenticate").mockImplementation(async (token) => {
      const who = sessions.get(token);
      return who ? { user: who, data: { userId: who.id, sid: token, authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } } : null;
    });
    spyOn(server, "guardAppAccessSocket").mockImplementation(async (_c, _appId, events) => events);
    const { createAppEventTestHarness } = await import("@k2b/cloud/events/testing");
    const { notebooksCapabilities } = await import("./capabilities");
    createAppEventTestHarness("notebooks", notebooksCapabilities);
    const { migrate } = await import("./migrate");
    const { notebooksService } = await import("./service");
    const { workspaceTransaction } = await import("./service/workspace-events");
    const { default: app, drainNotebookConnections } = await import("./ws");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("reader-presence");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const notebookId = crypto.randomUUID();
    const otherNotebookId = crypto.randomUUID();
    const notebookShortId = testShortId();
    const otherNotebookShortId = testShortId();
    const grants = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    type Message = {
      type: string;
      payload: { noteId?: string; code?: string; participants?: NotebookPresenceParticipant[]; cursor?: string };
    };
    const sockets: WebSocket[] = [];
    const waitFor = async (check: () => boolean, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check() && Date.now() < deadline) await Bun.sleep(10);
      expect(check()).toBe(true);
    };
    const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
    const open = async (session: string) => {
      const messages: Message[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${http.port}/?testSession=${session}`);
      sockets.push(socket);
      socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
      await waitFor(() => socket.readyState === WebSocket.OPEN);
      const send = (type: string, payload: object) => socket.send(JSON.stringify({ type, payload }));
      const people = (noteId: string) =>
        messages.filter((m) => m.payload.noteId === noteId && m.payload.participants).at(-1)?.payload.participants ?? [];
      return { socket, messages, send, people };
    };
    const watch = (socket: Awaited<ReturnType<typeof open>>, noteId: string | null, presencePeerId: string) =>
      socket.send("notes.workspace.presence.watch", { noteId, presencePeerId });
    const workspace = async (session: string) => {
      const socket = await open(session);
      socket.send("notes.workspace.subscribe", { notebookId: notebookShortId });
      await waitFor(() => socket.messages.some((m) => m.type === "notes.workspace.ready"));
      return socket;
    };
    const collab = async (session: string, noteId: string, presencePeerId: string) => {
      const socket = await open(session);
      socket.send("notes.yjs.replay.request", { noteId, restoreRevision: null, presencePeerId });
      await waitFor(() => socket.messages.some((m) => m.type === "notes.yjs.replay.ready"));
      return socket;
    };
    try {
      await sync.ready();
      await migrate();
      for (const who of [alice, bob]) {
        await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${who.id}::uuid, ${who.uid}, 'local', 'user')`;
      }
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Reader presence'), (${otherNotebookId}::uuid, ${otherNotebookShortId}, 'Other notebook')`;
      for (const [index, who, book, permission] of [
        [0, alice, notebookId, "read"],
        [1, bob, notebookId, "write"],
        [2, alice, otherNotebookId, "read"],
      ] as const) {
        await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${grants[index]!}::uuid, ${who.id}::uuid, ${permission})`;
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${book}::uuid, ${grants[index]!}::uuid)`;
      }
      const create = async (book: string) => {
        const result = await notebooksService.note.create({ data: { notebookId: book, contentMd: "# Presence\n" }, creatorId: bob.id });
        if (!result.ok) throw new Error(result.error);
        return result.data;
      };
      const first = await create(notebookId);
      const second = await create(notebookId);
      const other = await create(otherNotebookId);
      const alicePeer = crypto.randomUUID();
      const reader = await workspace("alice");
      watch(reader, first.shortId, alicePeer);
      await waitFor(() => reader.people(first.shortId).some((p) => p.userId === alice.id));
      // The client grouping token never merges different authenticated people.
      reader.send("notes.yjs.awareness.publish", { noteId: first.shortId, payload: "AA==" });
      await waitFor(() => reader.messages.some((m) => m.type === "notes.yjs.error" && m.payload.code === "INVALID_PAYLOAD"));
      const writer = await collab("bob", first.shortId, alicePeer);
      await waitFor(() => reader.people(first.shortId).length === 2 && writer.people(first.shortId).length === 2);
      expect(reader.messages.some((m) => m.type === "notes.yjs.sync.push" || m.type === "notes.yjs.replay.ready")).toBe(false);

      const doc = new Y.Doc();
      try {
        const state = await notebooksService.note.getAnchoredYjsState({ noteId: first.id });
        if (state?.yjsState) Y.applyUpdate(doc, state.yjsState);
        const before = Y.encodeStateVector(doc);
        doc.getText("codemirror").insert(0, "Edited by Bob\n");
        writer.send("notes.yjs.sync.publish", {
          noteId: first.shortId,
          payload: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
          restoreRevision: "0",
          baseCursor: writer.messages.find((m) => m.type === "notes.yjs.replay.ready")?.payload.cursor,
        });
        await waitFor(() => writer.messages.some((m) => m.type === "notes.yjs.sync.push" && !("snapshot" in m.payload)));
      } finally {
        doc.destroy();
      }

      // Fast switches replace the sole watched note; a locked note is still readable.
      await sql`UPDATE notebooks.notes SET locked_at = '2026-10-31T12:00:00Z' WHERE id = ${second.id}::uuid`;
      watch(reader, second.shortId, alicePeer);
      await waitFor(() => !writer.people(first.shortId).some((p) => p.userId === alice.id) && reader.people(second.shortId).length === 1);
      const switchesFrom = reader.messages.length;
      for (const noteId of [first.shortId, second.shortId, first.shortId]) watch(reader, noteId, alicePeer);
      // Watches run in order; the first switch already shows Alice to Bob, so wait for the last one,
      // whose own snapshot arrives only after the second note's lease was deleted.
      await waitFor(() => {
        const snapshots = reader.messages
          .slice(switchesFrom)
          .filter((m) => m.type === "notes.presence.snapshot")
          .map((m) => m.payload.noteId);
        return snapshots.join() === [first.shortId, second.shortId, first.shortId].join();
      });
      await waitFor(() => writer.people(first.shortId).some((p) => p.userId === alice.id));
      expect((await notebooksService.presence.snapshot({ noteId: second.id })).participants).toEqual([]);
      reader.socket.close();
      await waitFor(() => !writer.people(first.shortId).some((p) => p.userId === alice.id));

      const returning = await workspace("alice");
      watch(returning, first.shortId, alicePeer);
      await waitFor(() => writer.people(first.shortId).some((p) => p.userId === alice.id));
      // Upgrade the reader's permission and start editing from the same tab.
      await sql`UPDATE auth.access SET permission = 'write' WHERE id = ${grants[0]!}::uuid`;
      const editingReader = await collab("alice", first.shortId, alicePeer);
      const assertOneTab = async () => {
        const state = await notebooksService.presence.snapshot({ noteId: first.id });
        expect(state.participants.find((p) => p.userId === alice.id)?.peerCount).toBe(1);
      };
      await assertOneTab();
      editingReader.socket.close();
      await waitFor(() => editingReader.socket.readyState === WebSocket.CLOSED);
      await assertOneTab();
      // A distinct tab still counts, even for the same user.
      const extraTab = await workspace("alice");
      watch(extraTab, first.shortId, crypto.randomUUID());
      await waitFor(() => writer.people(first.shortId).find((p) => p.userId === alice.id)?.peerCount === 2);
      extraTab.socket.close();
      await waitFor(() => writer.people(first.shortId).find((p) => p.userId === alice.id)?.peerCount === 1);
      watch(returning, null, alicePeer);
      await waitFor(() => !writer.people(first.shortId).some((p) => p.userId === alice.id));

      // Readable elsewhere does not authorize presence through this notebook's socket.
      watch(returning, other.shortId, alicePeer);
      await waitFor(() => returning.messages.some((m) => m.type === "notes.workspace.error" && m.payload.code === "ACCESS_DENIED"));
      expect((await notebooksService.presence.snapshot({ noteId: other.id })).participants).toEqual([]);
      const denied = await workspace("bob");
      watch(denied, other.shortId, crypto.randomUUID());
      await waitFor(() => denied.messages.some((m) => m.type === "notes.workspace.error" && m.payload.code === "ACCESS_DENIED"));
      expect(denied.messages.some((m) => m.payload.participants)).toBe(false);

      // A lost note only ends its reader watch; the shared workspace stays live.
      for (const loss of ["deleted", "moved"] as const) {
        const lost = await create(notebookId);
        watch(returning, lost.shortId, alicePeer);
        await waitFor(() => returning.people(lost.shortId).length === 1);
        if (loss === "deleted") await sql`DELETE FROM notebooks.notes WHERE id = ${lost.id}::uuid`;
        else await sql`UPDATE notebooks.notes SET notebook_id = ${otherNotebookId}::uuid WHERE id = ${lost.id}::uuid`;
        // Deletion exercises the timer backstop; movement exercises immediate invalidation.
        if (loss === "moved")
          await workspaceTransaction((tx) =>
            notebooksService.workspaceEvents.invalidated({ notebookId, reason: "permissions", scopes: ["permissions"] }, tx),
          );
        await waitFor(() => returning.people(lost.shortId).length === 0, loss === "deleted" ? 15_000 : 5_000);
        expect(returning.socket.readyState).toBe(WebSocket.OPEN);
        expect((await notebooksService.presence.snapshot({ noteId: lost.id })).participants).toEqual([]);
        const priorEvents = returning.messages.filter((m) => m.type === "notes.workspace.event").length;
        await workspaceTransaction((tx) =>
          notebooksService.workspaceEvents.invalidated({ notebookId, reason: "bulk", scopes: ["tree"] }, tx),
        );
        await waitFor(() => returning.messages.filter((m) => m.type === "notes.workspace.event").length > priorEvents);
      }

      watch(returning, first.shortId, alicePeer);
      await waitFor(() => writer.people(first.shortId).some((p) => p.userId === alice.id));
      await sql`DELETE FROM notebooks.notebook_access WHERE access_id = ${grants[0]!}::uuid`;
      await workspaceTransaction((tx) =>
        notebooksService.workspaceEvents.invalidated({ notebookId, reason: "permissions", scopes: ["permissions"] }, tx),
      );
      await waitFor(() => returning.messages.some((m) => m.type === "notes.workspace.revoked"));
      await waitFor(() => !writer.people(first.shortId).some((p) => p.userId === alice.id));
    } finally {
      for (const socket of sockets) socket.close();
      await drainNotebookConnections();
      await http.stop(true);
      await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${otherNotebookId}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id IN (${grants[0]!}::uuid, ${grants[1]!}::uuid, ${grants[2]!}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${alice.id}::uuid, ${bob.id}::uuid)`;
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  }, 45_000);
}
