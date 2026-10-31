import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, sql, unbindProcessSync } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { createSync } from "@k2b/sync";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import * as Y from "yjs";
import { connectTestNats, requireInfra, suiteFor, testSyncNamespace, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import type { PublicNotebookWorkspaceEvent } from "../lib/workspace-events";
import * as noteRefs from "./note-refs";
import * as notes from "./notes";
import { createWorkspaceOutbox, latestCursor, workspaceTopic } from "./workspace-events";

suiteFor(
  "database",
  "nats",
  "valkey",
)("durable workspace hints", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
  let sync: ReturnType<typeof createSync> | undefined;
  let http: ReturnType<typeof Bun.serve> | undefined;
  let socket: WebSocket | undefined;
  let worker = createWorkspaceOutbox();
  let restorePublisher = () => {};
  let notebookId = "";
  let notebookShortId = "";
  let note: notes.Note;
  const received: { cursor: string; event: PublicNotebookWorkspaceEvent }[] = [];
  const user: User = {
    id: crypto.randomUUID(),
    uid: `workspace-reader-${crypto.randomUUID()}`,
    roles: [],
    provider: "local",
    profile: "user",
    givenname: "Workspace",
    sn: "Reader",
    displayName: "Workspace Reader",
    mail: "reader@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  // Test timeout bounds every condition wait; no fixed sleeps decide the result.
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = AbortSignal.timeout(15_000);
    while (!(await condition())) {
      deadline.throwIfAborted();
      await Bun.sleep(20);
    }
  };
  const pending = () => sql<{ attempts: number; payload: unknown }[]>`
    SELECT attempts, payload FROM notebooks.workspace_outbox WHERE notebook_id = ${notebookId}::uuid ORDER BY seq`;
  const save = async (text: string, createVersion = false, target = note) => {
    const doc = new Y.Doc();
    try {
      doc.getText("codemirror").insert(0, text);
      const saved = await notes.save({
        noteId: target.id,
        yjsState: Y.encodeStateAsUpdate(doc),
        contentMd: text,
        createdBy: createVersion ? user.id : null,
        createVersion,
      });
      expect(saved.ok).toBe(true);
      expect((await notes.get({ id: target.id }))?.contentMd).toBe(text);
    } finally {
      doc.destroy();
    }
  };
  const subscribe = async (after: string) => {
    const opened = Promise.withResolvers<void>();
    socket = new WebSocket(`ws://127.0.0.1:${http!.port}/`);
    socket.onopen = () => {
      socket!.send(JSON.stringify({ type: "notes.workspace.subscribe", payload: { notebookId: notebookShortId, fromCursor: after } }));
    };
    socket.onmessage = (message) => {
      const value = JSON.parse(String(message.data));
      if (value.type === "notes.workspace.ready") opened.resolve();
      if (value.type === "notes.workspace.event") received.push(value.payload);
      if (value.type === "notes.workspace.error") opened.reject(new Error(JSON.stringify(value.payload)));
    };
    socket.onerror = () => opened.reject(new Error("Workspace socket failed"));
    await opened.promise;
  };

  beforeAll(async () => {
    await requireInfra("database", "nats", "valkey");
    database = await useMigratedDatabase("workspace_outbox");
    connection = await connectTestNats();
    sync = createSync({
      connection,
      namespace: testSyncNamespace("workspace-outbox"),
      application: "notebooks",
      defaults: { replicas: 1 },
    });
    bindProcessSync(sync);
    await sync.ready();
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
    const server = await import("@k2b/cloud/server");
    // Authentication and app entry are fixture boundaries; notebook read access,
    // domain writes, outbox, broker, replay and socket projection are real.
    spyOn(server.auth, "requireRole").mockReturnValue(async (_c, next) => next());
    spyOn(server.auth.session, "resolveToken").mockResolvedValue("workspace-test");
    spyOn(server.auth.session, "authenticate").mockResolvedValue({
      user,
      data: {
        userId: user.id,
        sid: "workspace-test",
        authEpoch: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
        kind: "web",
      },
    });
    spyOn(server, "guardAppAccessSocket").mockImplementation(async (_c, _app, events) => events);
    const { default: routes } = await import("../ws");
    const router = new Hono().route("/", routes);
    http = Bun.serve({ port: 0, fetch: router.fetch, websocket });
  }, 120_000);

  beforeEach(async () => {
    setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
    received.length = 0;
    notebookId = crypto.randomUUID();
    notebookShortId = testShortId();
    await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Workspace outbox')`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id, permission) VALUES (${user.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO notebooks.notebook_access(notebook_id, access_id) VALUES (${notebookId}::uuid, ${grant!.id}::uuid)`;
    const created = await notes.create({ data: { notebookId, contentMd: "# Before" }, creatorId: null, exactContent: true });
    if (!created.ok) throw new Error(created.error);
    note = created.data;
    worker = createWorkspaceOutbox();
    await worker.reconcile();
    await subscribe(await latestCursor({ notebookId }));
  });
  afterEach(async () => {
    await worker.stop();
    if (socket) {
      const closed = Promise.withResolvers<void>();
      socket.onclose = () => closed.resolve();
      if (socket.readyState === WebSocket.CLOSED) closed.resolve();
      else socket.close();
      await closed.promise;
      socket = undefined;
    }
    restorePublisher();
    restorePublisher = () => {};
    setSystemTime();
  });
  afterAll(async () => {
    mock.restore();
    await worker.stop();
    await http?.stop(true);
    await sync?.drain({ timeoutMs: 5_000 });
    unbindProcessSync();
    await connection?.drain();
    await sql.close();
    await database?.drop();
  });

  test("a failed first publish commits the save and reaches the subscribed socket on retry without another write", async () => {
    const topic = workspaceTopic();
    const publish = topic.publish.bind(topic);
    const broker = spyOn(topic, "publish").mockImplementation(publish);
    broker.mockImplementationOnce(async () => {
      throw new Error("injected broker outage");
    });
    restorePublisher = () => broker.mockRestore();
    await save("# Committed during broker outage");
    expect(await pending()).toHaveLength(1);
    await worker.reconcile();
    expect((await pending())[0]?.attempts).toBe(1);
    expect(received).toHaveLength(0);
    worker.start();
    await until(() => received.length === 1);
    expect(received[0]!.event).toEqual({
      v: 1,
      type: "note.updated",
      notebookId: notebookShortId,
      note: { id: note.shortId, historyIncomplete: false },
    });
    expect(received[0]!.cursor).toMatch(/^s6t\./);
    await until(async () => (await pending()).length === 0);
    expect(broker).toHaveBeenCalledTimes(2);
  }, 30_000);

  test("a fresh dispatcher delivers a row committed before shutdown on start", async () => {
    await save("# Committed before process stopped");
    expect(await pending()).toHaveLength(1);
    expect(received).toHaveLength(0);
    await worker.stop();
    worker = createWorkspaceOutbox();
    worker.start();
    await until(() => received.length === 1);
    await until(async () => (await pending()).length === 0);
    expect(received[0]!.event.type).toBe("note.updated");
  }, 30_000);

  test("a lost broker acknowledgement retries the same ID without another visible event", async () => {
    const topic = workspaceTopic();
    const publish = topic.publish.bind(topic);
    const broker = spyOn(topic, "publish").mockImplementation(publish);
    broker.mockImplementationOnce(async (event) => {
      await publish(event);
      throw new Error("injected lost acknowledgement");
    });
    restorePublisher = () => broker.mockRestore();
    const after = await latestCursor({ notebookId });
    await save("# Saved once");
    await worker.reconcile();
    await until(() => received.length === 1);
    expect((await pending())[0]?.attempts).toBe(1);
    worker.start();
    await until(async () => (await pending()).length === 0);
    expect(broker).toHaveBeenCalledTimes(2);
    expect(broker.mock.calls[0]![0].idempotencyKey).toBe(broker.mock.calls[1]![0].idempotencyKey);
    const retained = [];
    for await (const event of topic.replay({ tenantId: notebookId, after })) retained.push(event);
    expect(retained).toHaveLength(1);
    expect(received).toHaveLength(1);
  }, 30_000);

  test("reference projections and activity are committed before the workspace hint is delivered", async () => {
    const topic = workspaceTopic();
    const publish = topic.publish.bind(topic);
    const broker = spyOn(topic, "publish").mockImplementation(async (event) => {
      const tags = await sql<{ tag: string }[]>`SELECT tag FROM notebooks.note_tags WHERE note_id = ${note.id}::uuid`;
      expect(tags.map((row) => row.tag)).toEqual(["durable"]);
      const [activity] = await sql`SELECT id FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'note.edited'`;
      expect(activity).toBeDefined();
      return publish(event);
    });
    restorePublisher = () => broker.mockRestore();
    worker.start();
    await save("# Tagged\n\n#durable", true);
    await until(() => received.length === 1);
    expect(broker).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("a failed reference projection rolls back its savepoint without losing the save or hint", async () => {
    const tags = await import("./tags");
    const reindex = spyOn(tags, "reindexTags").mockImplementationOnce(async (_params, tx) => {
      if (!tx) throw new Error("Expected the save transaction");
      await tx`SELECT 1 / 0`;
    });
    try {
      await save("# Committed despite a failed derived index");
      expect(await pending()).toHaveLength(1);
      worker.start();
      await until(() => received.length === 1);
    } finally {
      reindex.mockRestore();
    }
  }, 30_000);

  test("concurrent saves of mutually linked notes commit both reference projections", async () => {
    const created = await notes.create({ data: { notebookId, contentMd: "# Other" }, creatorId: null, exactContent: true });
    if (!created.ok) throw new Error(created.error);
    const other = created.data;
    const reindex = noteRefs.reindexNoteRefsSafe;
    let locked = 0;
    // Both saves hold their note locks before either projection checks the
    // target-note FK. FOR UPDATE would deadlock and lose one projection.
    const barrier = spyOn(noteRefs, "reindexNoteRefsSafe").mockImplementation(async (params, tx) => {
      locked++;
      await until(() => locked === 2);
      await reindex(params, tx);
    });
    try {
      await Promise.all([save(`[Other](note://${other.shortId})`), save(`[First](note://${note.shortId})`, false, other)]);
      const links = await sql<{ source_note_id: string; target_note_id: string }[]>`
        SELECT source_note_id, target_note_id FROM notebooks.note_links
        WHERE source_note_id IN (${note.id}::uuid, ${other.id}::uuid)`;
      expect(links).toHaveLength(2);
      expect(links).toContainEqual({ source_note_id: note.id, target_note_id: other.id });
      expect(links).toContainEqual({ source_note_id: other.id, target_note_id: note.id });
    } finally {
      barrier.mockRestore();
    }
  }, 30_000);

  test("rolling back a domain change also rolls back its workspace hint", async () => {
    const { noteUpdated } = await import("./workspace-events");
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE notebooks.notes SET content_md = '# Rolled back' WHERE id = ${note.id}::uuid`;
        await noteUpdated(note, tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await notes.get({ id: note.id }))?.contentMd).toBe("# Before");
    expect(await pending()).toHaveLength(0);
    expect(await worker.reconcile()).toBe(0);
    expect(received).toHaveLength(0);
  });
});
