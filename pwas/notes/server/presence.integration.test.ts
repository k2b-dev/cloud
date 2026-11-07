import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { frame, message } from "../protocol";
import { createNotesApp } from "./app";
import { migrate } from "./database";
import type { Connection } from "./service";
import { NotesService } from "./service";
import { NotesStore } from "./store";

const origin = "https://notes.example.test";
const options = { storageBytes: 1024 ** 3, maxConnections: 50, maxOpenPads: 5 };
const awareness = (state: unknown) =>
  frame(message.awareness, (e) =>
    encoding.writeVarUint8Array(
      e,
      frame(1, (a) => {
        encoding.writeVarUint(a, 12);
        encoding.writeVarUint(a, 1);
        encoding.writeVarString(a, JSON.stringify(state));
      }),
    ),
  );

databaseSuite()("Notes read-only overview presence", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let service: NotesService;
  let app: ReturnType<typeof createNotesApp>;
  let links: { readId: string; editId: string };
  let closed: { readId: string; editId: string };
  let sequence = 0;
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_presence");
    db = new SQL(database.url);
    await migrate(db);
  });
  beforeEach(async () => {
    setSystemTime(new Date("2026-10-30T12:00:00Z"));
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    const doc = new Y.Doc();
    doc.clientID = 11;
    doc.getText("text").insert(0, "hello");
    try {
      links = await service.create(Y.encodeStateAsUpdate(doc), "192.0.2.1");
      closed = await service.create(Y.encodeStateAsUpdate(doc), "192.0.2.1");
    } finally {
      doc.destroy();
    }
    app = createNotesApp(async () => true, service, { origin });
  });
  afterEach(async () => {
    await service.stop();
    await db`TRUNCATE pads CASCADE`;
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
    await database.drop();
  });
  const connect = async (token: string) => {
    const connection = await service.admit(token, `198.51.100.${++sequence}`);
    await service.attach(connection, { send: () => {}, close: () => {}, bufferedAmount: () => 0 });
    return connection;
  };
  const publish = (connection: Connection, name: string) =>
    service.receive(connection, awareness({ user: { name, color: "forged" }, secret: "never exposed" }));
  const poll = (readIds: string[], requestOrigin = origin) =>
    app.request("/api/presence", {
      method: "POST",
      headers: { Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ readIds }),
    });

  test("returns only sanitized editor names and server colors, without loading or writing notes", async () => {
    const editor = await connect(links.editId);
    const reader = await connect(links.readId);
    await publish(editor, "  Ａnna\u0000\u200b  ");
    await publish(reader, "Reader");
    const [before] = await db`SELECT json_agg(pads ORDER BY read_id)::text AS state FROM pads`;
    const methods = ["load", "resolve", "transaction", "humanOpen"] as const;
    const originals = methods.map((key) => service.store[key]);
    for (const key of methods)
      service.store[key] = async () => {
        throw new Error("presence_must_not_load_or_write");
      };
    try {
      const response = await poll([links.readId, links.readId, links.editId, closed.readId, "0".repeat(22)]);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      const people = await response.json();
      expect(people[links.readId]).toEqual([{ name: "Anna", color: editor.awareness.person!.color }]);
      expect(people[links.readId][0].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(people[links.editId]).toEqual([]);
      expect(people[closed.readId]).toEqual([]);
      expect(people["0".repeat(22)]).toEqual([]);
      expect(Object.keys(people)).toHaveLength(4);
      const [after] = await db`SELECT json_agg(pads ORDER BY read_id)::text AS state FROM pads`;
      expect(after).toEqual(before);
    } finally {
      for (const [index, key] of methods.entries()) Object.assign(service.store, { [key]: originals[index] });
    }
  });
  test("unpublished, removed, disconnected, blocked and deleted presence disappears", async () => {
    const editor = await connect(links.editId);
    expect(await (await poll([links.readId])).json()).toEqual({ [links.readId]: [] });
    await publish(editor, "Anna");
    expect((await (await poll([links.readId])).json())[links.readId]).toHaveLength(1);
    await service.receive(editor, awareness(null));
    expect(await (await poll([links.readId])).json()).toEqual({ [links.readId]: [] });
    await publish(editor, "Anna");
    service.disconnect(editor);
    expect(await (await poll([links.readId])).json()).toEqual({ [links.readId]: [] });
    await publish(await connect(links.editId), "Anna");
    await service.removeReadId(links.readId, "block", "fixture");
    expect(await (await poll([links.readId])).json()).toEqual({ [links.readId]: [] });
    await publish(await connect(closed.editId), "Bob");
    await service.remove(closed.editId);
    expect(await (await poll([closed.readId])).json()).toEqual({ [closed.readId]: [] });
  });
  test("bounds request size, ID count and syntax, and requires the exact Origin", async () => {
    expect((await poll([links.readId], "https://other.example.test")).status).toBe(403);
    expect((await poll(Array(201).fill(links.readId))).status).toBe(400);
    expect((await poll(["invalid"])).status).toBe(400);
    expect((await poll(Array(200).fill(links.readId))).status).toBe(200);
    expect((await poll([])).status).toBe(200);
    const large = await app.request("/api/presence", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: " ".repeat(6000),
    });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ code: "body_limit" });
  });
  test("has an independent IP rate window and bounded concurrent owner checks", async () => {
    for (let index = 0; index < 50; index++) expect((await poll([links.readId])).status).toBe(200);
    expect((await poll([links.readId])).status).toBe(429);
    expect((await app.request(`/api/pads/${links.readId}`)).status).toBe(200);
    const ownsDatabase = service.store.ownsDatabase.bind(service.store);
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    service.store.ownsDatabase = async () => {
      if (++checks <= options.maxOpenPads) await waiting;
      return true;
    };
    const pending = Array.from({ length: options.maxOpenPads }, () => service.presence([links.readId]));
    try {
      await expect(service.presence([links.readId])).rejects.toMatchObject({ code: "overloaded" });
      expect((await service.read(links.readId)).content).toBe("hello");
    } finally {
      release();
      await Promise.all(pending);
      service.store.ownsDatabase = ownsDatabase;
    }
    expect(await service.presence([links.readId])).toEqual({ [links.readId]: [] });
  });
  test("shutdown returns a visible retryable unavailable state", async () => {
    await service.stop();
    const response = await poll([links.readId]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
  });
  test("does not return stale awareness after the database owner changes", async () => {
    await publish(await connect(links.editId), "Anna");
    const [owner] = await db<{ owner_id: string }[]>`SELECT owner_id FROM notes_storage WHERE singleton`;
    await db`UPDATE notes_storage SET owner_id='successor' WHERE singleton`;
    const response = await poll([links.readId]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
    await db`UPDATE notes_storage SET owner_id=${owner!.owner_id} WHERE singleton`;
  });
});
