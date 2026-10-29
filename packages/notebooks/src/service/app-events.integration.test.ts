import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { createSync } from "@k2b/sync";
import { sql } from "bun";
import * as Y from "yjs";
import { connectTestNats, suiteFor, testInfra, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import * as producer from "../app-events";
import { notebooksCapabilities } from "../capabilities";
import { migrate } from "../migrate";
import * as notebooks from "./notebooks";
import * as notes from "./notes";

setDefaultTimeout(30_000);
const dateConfig = { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 as const };
const suite = suiteFor("database", "nats");
const notebookIds: string[] = [];
const userIds: string[] = [];
let owner: CapabilityExecutionContext;
let other: CapabilityExecutionContext;
let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
let sync: ReturnType<typeof createSync> | undefined;
const syncNamespace = testSyncNamespace("notebook-events");
const context = (id: string): CapabilityExecutionContext => {
  const user: User = {
    id,
    uid: id,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Private",
    sn: "Name",
    displayName: "Private Name",
    mail: "private@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  return {
    user,
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: id },
    requestId: "events-test",
    origin: "app",
    locale: "en",
    signal: new AbortController().signal,
  };
};
beforeEach(() => setSystemTime(new Date("2026-10-27T12:00:00Z")));
afterEach(async () => {
  setSystemTime();
  if (!testInfra.database) return;
  for (const id of notebookIds)
    await sql`UPDATE notebooks.notes
    SET app_event_pending_since = NULL, app_event_changed_at = NULL WHERE notebook_id = ${id}::uuid`;
});
beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats) return;
  await migrate();
  await sql`UPDATE notebooks.app_event_sweep SET last_swept_at = NULL`;
  connection = await connectTestNats();
  sync = createSync({ connection, namespace: syncNamespace, application: "notebooks", defaults: { replicas: 1 } });
  bindProcessSync(sync);
  await sync.ready();
  const workspace = await import("./workspace-events");
  const { createYjsTopic } = await import("./yjs-sync");
  await workspace.latestCursor({ notebookId: crypto.randomUUID() });
  await createYjsTopic().head();
  for (let i = 0; i < 2; i++) {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile)
      VALUES (${`producer-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
    userIds.push(user!.id);
  }
  owner = context(userIds[0]!);
  other = context(userIds[1]!);
});
afterAll(async () => {
  if (!testInfra.database || !testInfra.nats) return;
  for (const id of notebookIds) {
    const [book] = await sql<{ short_id: string }[]>`SELECT short_id FROM notebooks.notebooks WHERE id = ${id}::uuid`;
    await sql`DELETE FROM events.outbox WHERE app_id = 'notebooks' AND payload->'place'->>'id' = ${book?.short_id ?? ""}`;
    await notebooks.remove({ id });
  }
  for (const id of userIds) {
    await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  }
  await sql`UPDATE notebooks.app_event_sweep SET last_swept_at = NULL`;
  await sync?.drain({ timeoutMs: 5_000 });
  unbindProcessSync();
  if (connection) {
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      if (stream.config.metadata?.["sync.namespace"] === syncNamespace) await manager.streams.delete(stream.config.name);
    }
  }
  await connection?.drain();
});
const notebook = async (seedWelcome = false) => {
  const result = await notebooks.create({
    data: { name: "Secret notebook", description: "Secret description" },
    creatorId: userIds[0]!,
    seedWelcome,
  });
  if (!result.ok) throw new Error(result.error);
  notebookIds.push(result.data.id);
  return result.data;
};
const note = async (notebookId: string, contentMd = "# Secret title\n\nSecret text") => {
  const result = await notes.create({ data: { notebookId, contentMd }, exactContent: true, creatorId: userIds[0]! });
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const save = (noteId: string, contentMd: string) => {
  const doc = new Y.Doc();
  doc.clientID = 7;
  doc.getText("codemirror").insert(0, contentMd);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return notes.save({ noteId, yjsState: state, contentMd, createdBy: userIds[0]!, requestedAt: Date.now() });
};
const pending = async (shortId: string): Promise<AppEventEnvelope[]> =>
  (
    await sql<{ payload: AppEventEnvelope }[]>`SELECT payload FROM events.outbox WHERE app_id = 'notebooks'
    AND kind = 'event' AND payload->'place'->>'id' = ${shortId} ORDER BY seq`
  ).map((row) => row.payload);
const assertThin = (event: AppEventEnvelope) => {
  expect(Object.keys(event).sort()).toEqual(["data", "id", "place", "source", "subject", "time", "type", "version"]);
  expect(Object.keys(event.data && typeof event.data === "object" ? event.data : { invalid: true })).toEqual([]);
  expect(event.data).toEqual({});
  expect(event.version).toBe(1);
  expect(event.source).toBe("notebooks");
  expect(Object.keys(event.subject).sort()).toEqual(["id", "type"]);
  expect(Object.keys(event.place!).sort()).toEqual(["id", "type"]);
};
let sweepTime = Date.parse("2030-01-01T00:00:00Z");
const flush = async () => {
  sweepTime += producer.NOTE_UPDATED_SWEEP_MS;
  const now = new Date(sweepTime);
  for (const id of notebookIds)
    await sql`UPDATE notebooks.notes
    SET app_event_pending_since = ${new Date(sweepTime - producer.NOTE_UPDATED_QUIET_MS)},
        app_event_changed_at = ${new Date(sweepTime - producer.NOTE_UPDATED_QUIET_MS)}
    WHERE notebook_id = ${id}::uuid AND app_event_pending_since IS NOT NULL`;
  return producer.sweepNoteUpdates(now);
};
const marker = async (id: string) =>
  (
    await sql<{ pending: Date | null }[]>`
  SELECT app_event_pending_since AS pending FROM notebooks.notes WHERE id = ${id}::uuid`
  )[0]!.pending;

suite("Notebooks declared resource event producers", () => {
  test("all four declarations emit thin public refs; readers enforce two users' different rights", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    expect((await notebooks.update({ dateConfig, id: book.id, data: { name: "New secret" } })).ok).toBe(true);
    expect((await save(entry.id, "# Changed secret\nPrivate text")).ok).toBe(true);
    await flush();
    const events = await pending(book.shortId);
    expect(events.map((e) => e.type)).toEqual([
      "notebooks.notebook.created",
      "notebooks.note.created",
      "notebooks.notebook.updated",
      "notebooks.note.updated",
    ]);
    for (const event of events) {
      assertThin(event);
      await expect(deliverAppEvent(notebooksCapabilities, event.type, event, { appId: "notebooks" })).rejects.toThrow(
        "resource_events_unsupported",
      );
      expect(event.place).toEqual({ type: "notebooks.notebook", id: book.shortId });
      expect(event.subject).toEqual({
        type: event.type.includes(".notebook.") ? "notebooks.notebook" : "notebooks.note",
        id: event.type.includes(".notebook.") ? book.shortId : entry.shortId,
      });
      const place = notebooksCapabilities.queries["notebook.read"];
      expect((await place.run(place.input.parse({ id: event.place!.id }), owner)).ok).toBe(true);
      expect((await place.run(place.input.parse({ id: event.place!.id }), other)).ok).toBe(false);
      if (event.subject.type === "notebooks.note") {
        const reader = notebooksCapabilities.queries["note.read"];
        expect((await reader.run(reader.input.parse({ id: event.subject.id }), owner)).ok).toBe(true);
        expect((await reader.run(reader.input.parse({ id: event.subject.id }), other)).ok).toBe(false);
      }
    }
    const measurement = sync!.topic<AppEventEnvelope>({
      id: "envelope-measurement",
      retention: { maxBytes: 1024 ** 2, maxAgeMs: 7 * 24 * 3_600_000 },
      deadLetterRetention: { maxBytes: 1024 ** 2 },
    });
    try {
      let previousBytes = 0;
      for (const name of Object.keys(producer.notebooksEvents) as (keyof typeof producer.notebooksEvents)[]) {
        const fixture = appEventFixture(notebooksCapabilities, name, { subject: entry.shortId, place: book.shortId, data: {} });
        const compact = Buffer.byteLength(JSON.stringify(fixture));
        const [stored] = await sql<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(fixture)}::text::jsonb::text) AS bytes`;
        expect(compact).toBe(name.startsWith("notebook.") ? 264 : 256);
        expect(stored!.bytes).toBe(compact + 21);
        await measurement.publish({ data: fixture, orderingKey: "0".repeat(64), idempotencyKey: crypto.randomUUID() });
        const inventory = (await Array.fromAsync(sync!.listTopics({ idPrefix: "envelope-measurement" })))[0]!;
        console.info("Envelope bytes", { name, compact, jsonb: stored!.bytes, retained: inventory.bytes - previousBytes });
        previousBytes = inventory.bytes;
      }
    } finally {
      await measurement.destroy();
    }
    for (const declaration of Object.values(producer.notebooksEvents))
      expect(declaration.schema.safeParse({ title: "hidden" }).success).toBe(false);
    expect(notebooksCapabilities.types.notebook.reader).toBe("notebook.read");
  });
  test("durable text saves and metadata coalesce; unchanged or fenced snapshots emit nothing", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    const parent = await note(book.id);
    expect((await save(entry.id, entry.contentMd ?? "")).ok).toBe(true);
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(0);
    const results = await Promise.all([save(entry.id, "# First"), save(entry.id, "# Second")]);
    expect(results.every((result) => result.ok)).toBe(true);
    const firstPending = await marker(entry.id);
    expect((await notes.move({ id: entry.id, parentId: parent.id, locale: "en" })).ok).toBe(true);
    expect(await marker(entry.id)).toEqual(firstPending);
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(0);
    await flush();
    expect((await save(entry.id, "# Third")).ok).toBe(true);
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(1);
    await flush();
    const current = await notes.getYjsStateWithCursor({ noteId: entry.id });
    // A restore revision newer than the snapshot prevents persistence and event publication.
    await sql`UPDATE notebooks.notes SET yjs_restore_revision = yjs_restore_revision + 1 WHERE id = ${entry.id}::uuid`;
    const { createYjsTopic } = await import("./yjs-sync");
    const head = await createYjsTopic().head();
    await notes.save({
      noteId: entry.id,
      yjsState: new Uint8Array(),
      contentMd: "# Stale",
      createdBy: userIds[0]!,
      streamCursor: head,
      restoreRevision: current!.restoreRevision,
      requestedAt: Date.now(),
    });
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(2);
  });
  test("shared-text updates emit only when their replay becomes a durable snapshot", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    const stored = await notes.getAnchoredYjsState({ noteId: entry.id });
    if (!stored?.yjsState) throw new Error("Expected anchored state");
    const { createYjsTopic, NODE_ID, toBase64 } = await import("./yjs-sync");
    const topic = createYjsTopic();
    const doc = new Y.Doc();
    doc.clientID = 7;
    Y.applyUpdate(doc, stored.yjsState);
    let cursor = stored.streamCursor!;
    try {
      for (let n = 0; n < 4; n++) {
        const before = Y.encodeStateVector(doc);
        doc.getText("codemirror").insert(doc.getText("codemirror").length, "x");
        const published = await topic.publish({
          tenantId: entry.id,
          data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(doc, before)), originNodeId: NODE_ID, originPeerId: null },
        });
        cursor = published.cursor;
      }
      expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(0);
      const replayed = await notes.noteDocuments.read(entry.id);
      expect(replayed!.text).toBe((entry.contentMd ?? "") + "xxxx");
      expect(
        (
          await notes.save({
            noteId: entry.id,
            yjsState: replayed!.state!,
            contentMd: replayed!.text ?? "",
            streamCursor: cursor,
            restoreRevision: stored.restoreRevision,
            requestedAt: Date.now(),
            createdBy: null,
          })
        ).ok,
      ).toBe(true);
      expect(await marker(entry.id)).not.toBeNull();
      await flush();
      expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(1);
      expect((await notes.get({ id: entry.id }))!.contentMd).toBe(replayed!.text);
    } finally {
      doc.destroy();
    }
  });
  test("moving carries no parent or destination; cross-notebook moves remain refused", async () => {
    const book = await notebook();
    const target = await notebook();
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id, permission)
      VALUES (${userIds[1]!}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO notebooks.notebook_access(notebook_id, access_id) VALUES (${book.id}::uuid, ${grant!.id}::uuid)`;
    const entry = await note(book.id);
    const parent = await note(book.id);
    const foreignParent = await note(target.id);
    expect((await notes.move({ id: entry.id, parentId: parent.id, locale: "en" })).ok).toBe(true);
    await flush();
    const events = await pending(book.shortId);
    const moved = events.find((e) => e.type === "notebooks.note.updated")!;
    assertThin(moved);
    expect(moved.subject.id).toBe(entry.shortId);
    expect(JSON.stringify(moved)).not.toContain(parent.shortId);
    expect(JSON.stringify(moved)).not.toContain(parent.id);
    expect((await notes.move({ id: entry.id, parentId: foreignParent.id, locale: "en" })).ok).toBe(false);
    expect(await pending(book.shortId)).toEqual(events);
    expect(JSON.stringify(events)).not.toContain(target.shortId);
    const reader = notebooksCapabilities.queries["note.read"];
    expect((await reader.run(reader.input.parse({ id: entry.shortId }), other)).ok).toBe(true);
    const copy = await notes.copyToNotebook({ noteId: entry.id, targetNotebookId: target.id, creatorId: userIds[0]! });
    if (!copy.ok) throw new Error(copy.error);
    expect(await pending(book.shortId)).toEqual(events);
    const copied = (await pending(target.shortId)).find((e) => e.subject.id === copy.data.shortId)!;
    assertThin(copied);
    expect(copied.type).toBe("notebooks.note.created");
    expect(copied.place!.id).toBe(target.shortId);
    expect((await reader.run(reader.input.parse({ id: copy.data.shortId }), other)).ok).toBe(false);
  });
  test("order and lock metadata changes count; an unchanged placement leaves no marker", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    expect((await notes.move({ id: entry.id, placement: { position: 0 }, locale: "en" })).ok).toBe(true);
    await flush();
    const before = await pending(book.shortId);
    expect((await notes.move({ id: entry.id, placement: { position: 0 }, locale: "en" })).ok).toBe(true);
    expect(await pending(book.shortId)).toEqual(before);
    expect(await marker(entry.id)).toBeNull();
    expect((await notes.lock({ id: entry.id, permission: "admin" })).ok).toBe(true);
    await flush();
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.note.updated")).toHaveLength(2);
  });
  test("settings changes publish once; welcome-note creation shares its notebook transaction", async () => {
    const book = await notebook(true);
    expect((await pending(book.shortId)).map((e) => e.type)).toEqual(["notebooks.notebook.created", "notebooks.note.created"]);
    expect((await notebooks.update({ dateConfig, id: book.id, data: { name: book.name } })).ok).toBe(true);
    expect((await notebooks.update({ dateConfig, id: book.id, data: { noteDeletePermission: "admin" } })).ok).toBe(true);
    expect((await pending(book.shortId)).filter((e) => e.type === "notebooks.notebook.updated")).toHaveLength(1);
  });
  test("rollback removes discrete facts and leaves a failed sweep pending for retry", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    const original = producer.publishNotebooksEvent;
    const failure = spyOn(producer, "publishNotebooksEvent").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("producer rollback");
    });
    try {
      await expect(note(book.id)).rejects.toThrow("producer rollback");
      expect((await save(entry.id, "# Pending update")).ok).toBe(true);
      await expect(flush()).rejects.toThrow("producer rollback");
      expect(await marker(entry.id)).not.toBeNull();
      // Fail the seed after the notebook event and creator grant have already been written in the transaction.
      failure.mockImplementation(async (...args) => {
        await original(...args);
        if (args[1] === "note.created") throw new Error("producer rollback");
      });
      const [before] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.access WHERE user_id = ${userIds[0]!}::uuid`;
      await expect(notebooks.create({ data: { name: "Rollback notebook" }, creatorId: userIds[0]!, seedWelcome: true })).rejects.toThrow(
        "producer rollback",
      );
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.access WHERE user_id = ${userIds[0]!}::uuid`)[0]!.count,
      ).toBe(before!.count);
      expect(
        (
          await sql<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM notebooks.notebooks WHERE name = 'Rollback notebook' AND created_by = ${userIds[0]!}::uuid`
        )[0]!.count,
      ).toBe(0);
    } finally {
      failure.mockRestore();
    }
    expect((await pending(book.shortId)).map((e) => e.type)).toEqual(["notebooks.notebook.created", "notebooks.note.created"]);
    const [stored] = await sql<{ content_md: string }[]>`SELECT content_md
      FROM notebooks.notes WHERE id = ${entry.id}::uuid`;
    expect(stored).toEqual({ content_md: "# Pending update" });
    expect(
      (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notebooks.notes WHERE notebook_id = ${book.id}::uuid`)[0]!.count,
    ).toBe(1);
    expect((await save(entry.id, "# After rollback")).ok).toBe(true);
    expect(await producer.sweepNoteUpdates(new Date(sweepTime))).toBe(1);
    expect((await pending(book.shortId)).at(-1)!.type).toBe("notebooks.note.updated");
  });
  test("save then lock retains the final change until the quiet period", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    expect((await save(entry.id, "# Last content")).ok).toBe(true);
    expect((await notes.lock({ id: entry.id, permission: "admin" })).ok).toBe(true);
    sweepTime += 600_000;
    const now = new Date(sweepTime);
    await sql`UPDATE notebooks.notes SET app_event_pending_since = ${now}, app_event_changed_at = ${now} WHERE id = ${entry.id}::uuid`;
    expect(await producer.sweepNoteUpdates(now)).toBe(0);
    expect(await marker(entry.id)).not.toBeNull();
    expect(await producer.sweepNoteUpdates(new Date(now.getTime() + producer.NOTE_UPDATED_SWEEP_MS))).toBe(1);
    expect(await marker(entry.id)).toBeNull();
    expect((await pending(book.shortId)).at(-1)!.subject.id).toBe(entry.shortId);
    expect((await notes.get({ id: entry.id }))!.lockedAt).not.toBeNull();
    sweepTime += producer.NOTE_UPDATED_SWEEP_MS;
  });
  test("sweep bounds the entire batch across concurrent ticks, honors max delay and skips locked rows", async () => {
    const book = await notebook();
    const entries = [];
    for (let i = 0; i < producer.NOTE_UPDATED_BATCH + 2; i++) entries.push(await note(book.id));
    sweepTime += 600_000;
    const now = new Date(sweepTime);
    // Recent continuous edits become eligible through max delay; newer rows remain pending.
    await sql`UPDATE notebooks.notes SET app_event_pending_since = ${new Date(now.getTime() - producer.NOTE_UPDATED_MAX_DELAY_MS)},
      app_event_changed_at = ${now} WHERE notebook_id = ${book.id}::uuid`;
    const newest = entries.at(-1)!;
    await sql`UPDATE notebooks.notes SET app_event_pending_since = ${now} WHERE id = ${newest.id}::uuid`;
    const held = entries[0]!;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM notebooks.notes WHERE id = ${held.id}::uuid FOR UPDATE`;
      const counts = await Promise.all([producer.sweepNoteUpdates(now), producer.sweepNoteUpdates(now)]);
      expect(counts.sort((a, b) => a - b)).toEqual([0, producer.NOTE_UPDATED_BATCH]);
    });
    expect(await marker(held.id)).not.toBeNull();
    expect(await marker(newest.id)).not.toBeNull();
    expect(await producer.sweepNoteUpdates(new Date(now.getTime() + producer.NOTE_UPDATED_SWEEP_MS - 1))).toBe(0);
    expect(await producer.sweepNoteUpdates(new Date(now.getTime() + producer.NOTE_UPDATED_SWEEP_MS))).toBe(2);
    expect((await pending(book.shortId)).filter((e) => e.type.endsWith("note.updated"))).toHaveLength(entries.length);
    sweepTime += producer.NOTE_UPDATED_SWEEP_MS;
  });
  test("move and resetOrder never mark renumbered siblings or derived parent hasChildren", async () => {
    const book = await notebook();
    const a = await note(book.id, "# A");
    const b = await note(book.id, "# B");
    const parent = await note(book.id, "# Parent");
    expect((await notes.move({ id: a.id, placement: { position: 0 }, locale: "en" })).ok).toBe(true);
    expect(await flush()).toBe(1);
    expect((await notes.move({ id: b.id, placement: { position: 0 }, locale: "en" })).ok).toBe(true);
    expect(await marker(a.id)).toBeNull();
    expect(await marker(b.id)).not.toBeNull();
    expect(await flush()).toBe(1);
    expect((await notes.resetOrder({ notebookId: book.id, parentId: null })).ok).toBe(true);
    expect(await flush()).toBe(0);
    expect((await notes.move({ id: a.id, parentId: parent.id, locale: "en" })).ok).toBe(true);
    expect(await marker(parent.id)).toBeNull();
    expect(await flush()).toBe(1);
  });
  test("restoreFromSnapshot marks changed content; restoreAsCopy emits only its new note", async () => {
    const book = await notebook();
    const empty = await note(book.id, "");
    const doc = new Y.Doc();
    doc.clientID = 7;
    doc.getText("codemirror").insert(0, "# Recovered");
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    doc.destroy();
    expect((await notes.restoreFromSnapshot({ noteId: empty.id, yjsSnapshot: snapshot, createdBy: userIds[0]! })).ok).toBe(true);
    expect(await marker(empty.id)).not.toBeNull();
    expect(await flush()).toBe(1);
    const [version] = await sql<{ id: string }[]>`SELECT id FROM notebooks.note_versions WHERE note_id = ${empty.id}::uuid LIMIT 1`;
    const copy = await notes.restoreAsCopy({ noteId: empty.id, versionId: version!.id, creatorId: userIds[0]! });
    if (!copy.ok) throw new Error(copy.error);
    expect((await pending(book.shortId)).at(-1)!.type).toBe("notebooks.note.created");
    expect((await pending(book.shortId)).at(-1)!.subject.id).toBe(copy.data.shortId);
    expect(await flush()).toBe(0);
  });
  test("legacy anchoring marks changed replayed content but leaves unchanged anchors alone", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    const unchanged = await note(book.id);
    const { createYjsTopic, NODE_ID, toBase64 } = await import("./yjs-sync");
    const doc = new Y.Doc();
    doc.clientID = 7;
    doc.getText("codemirror").insert(0, "# Anchored content");
    await sql`UPDATE notebooks.notes SET yjs_stream_cursor = NULL, yjs_stream_seq = NULL WHERE notebook_id = ${book.id}::uuid`;
    await createYjsTopic().publish({
      tenantId: entry.id,
      data: {
        kind: "sync",
        payload: toBase64(Y.encodeStateAsUpdate(doc)),
        originNodeId: NODE_ID,
        originPeerId: null,
      },
    });
    doc.destroy();
    expect((await notes.getAnchoredYjsState({ noteId: entry.id }))!.contentMd).toContain("Anchored content");
    await notes.getAnchoredYjsState({ noteId: unchanged.id });
    expect(await marker(unchanged.id)).toBeNull();
    expect(await flush()).toBe(1);
  });
  test("a marker failure rolls back the domain write and leaves no pending change", async () => {
    const book = await notebook();
    const entry = await note(book.id);
    const original = producer.markNoteUpdated;
    const failure = spyOn(producer, "markNoteUpdated").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("marker rollback");
    });
    try {
      await expect(save(entry.id, "# Must roll back")).rejects.toThrow("marker rollback");
    } finally {
      failure.mockRestore();
    }
    expect((await notes.getWithContent({ id: entry.id }))!.contentMd).toBe(entry.contentMd!);
    expect(await marker(entry.id)).toBeNull();
    expect(await flush()).toBe(0);
  });
});
