import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { frame, message, readReply, updateFrame } from "../protocol";
import { createNotesApp } from "./app";
import { migrate } from "./database";
import { decodeDocument } from "./document";
import { limits, RateLimits, rateKey, requestIp } from "./limits";
import { serveNotes } from "./runtime";
import { NotesService } from "./service";
import { costs, NotesStore } from "./store";

const FIXED = new Date("2026-10-30T12:00:00.000Z");
const options = { storageBytes: 1024 ** 3, maxConnections: 200, maxOpenPads: 100 };
const origin = "https://notes.example.test";
// Bun supports request headers; lib.dom exposes only the browser constructor overload.
const BunSocket = WebSocket as typeof WebSocket & { new (url: string, options: Bun.WebSocketOptions): WebSocket };
const initial = () => {
  const doc = new Y.Doc();
  doc.clientID = 11;
  doc.getText("text").insert(0, "hello");
  return doc;
};
const awareness = (id: number, state: unknown) =>
  frame(message.awareness, (e) =>
    encoding.writeVarUint8Array(
      e,
      frame(1, (a) => {
        encoding.writeVarUint(a, id);
        encoding.writeVarUint(a, 99999);
        encoding.writeVarString(a, JSON.stringify(state));
      }),
    ),
  );
const decodedAwareness = (bytes: Uint8Array) => {
  const outer = decoding.createDecoder(bytes);
  expect(decoding.readVarUint(outer)).toBe(message.awareness);
  const inner = decoding.createDecoder(decoding.readVarUint8Array(outer));
  expect(decoding.readVarUint(inner)).toBe(1);
  return { id: decoding.readVarUint(inner), clock: decoding.readVarUint(inner), state: JSON.parse(decoding.readVarString(inner)) };
};

databaseSuite()("Notes durable Yjs sync", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let service: NotesService;
  let sequence = 0;
  const docs: Y.Doc[] = [];
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_sync");
    db = new SQL(database.url);
    await migrate(db);
  });
  beforeEach(async () => {
    setSystemTime(FIXED);
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
  });
  afterEach(async () => {
    await service.stop();
    for (const doc of docs.splice(0)) doc.destroy();
    await db`TRUNCATE pads CASCADE`;
    await db`UPDATE notes_storage SET used_bytes=0,owner_id=NULL WHERE singleton`;
  });
  afterAll(async () => {
    setSystemTime();
    await db?.close();
    await database?.drop();
  });
  const pad = async () => {
    const doc = initial();
    docs.push(doc);
    return { ...(await service.create(Y.encodeStateAsUpdate(doc), `192.0.2.${++sequence}`)), doc };
  };
  const connect = async (token: string, ip = `198.51.100.${++sequence}`) => {
    const connection = await service.admit(token, ip);
    const sent: Uint8Array[] = [];
    const closed: { code: number; reason: string }[] = [];
    let buffered = 0;
    await service.attach(connection, {
      send: (bytes) => {
        sent.push(bytes);
      },
      close: (code, reason) => {
        closed.push({ code, reason });
      },
      bufferedAmount: () => buffered,
    });
    return {
      connection,
      sent,
      closed,
      buffer: (value: number) => {
        buffered = value;
      },
    };
  };
  const edit = (source: Y.Doc, id: number, text: string) => {
    const doc = new Y.Doc();
    doc.clientID = id;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    const vector = Y.encodeStateVector(doc);
    doc.getText("text").insert(doc.getText("text").length, text);
    docs.push(doc);
    return { doc, update: Y.encodeStateAsUpdate(doc, vector) };
  };
  const replies = (sent: Uint8Array[]) => sent.map(readReply).filter((value) => value !== null);
  const waitForCrashedOwner = () =>
    db.begin(async (tx) => {
      // Process exit precedes Postgres observing EOF on the owner's separate connection.
      // Synchronize on that session lock instead of racing the successor's try-lock.
      await tx`SET LOCAL lock_timeout='2s'`;
      await tx`SELECT pg_advisory_xact_lock(726628314)`;
    });

  test("concurrent offline edits merge, acknowledge after persistence, and survive compaction", async () => {
    const shared = await pad();
    const a = edit(shared.doc, 12, " A");
    const b = edit(shared.doc, 13, " B");
    const left = await connect(shared.editId);
    const right = await connect(shared.editId);
    await Promise.all([
      service.receive(left.connection, updateFrame("left", a.update)),
      service.receive(right.connection, updateFrame("right", b.update)),
      service.compact(shared.readId),
    ]);
    const merged = await service.read(shared.readId);
    Y.applyUpdate(a.doc, b.update);
    expect(merged.content).toBe(a.doc.getText("text").toString());
    expect(replies(left.sent)).toContainEqual({ type: "ack", id: "left" });
    const [countRow] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pad_updates WHERE read_id=${shared.readId}`;
    expect(countRow!.count).toBeLessThanOrEqual(2);
    const restarted = await service.store.load(shared.readId);
    expect(restarted.doc.getText("text").toString()).toBe(merged.content);
    restarted.doc.destroy();
    const [totalRow] = await db<{ total: string }[]>`SELECT sum(size_bytes)::text AS total FROM pads`;
    expect((await service.store.status()).usedBytes).toBe(Number(totalRow!.total));
  });

  test("the read link cannot send sync step 2, standard updates, custom updates, or delete", async () => {
    const shared = await pad();
    const next = edit(shared.doc, 12, " forbidden");
    for (const payload of [
      frame(message.sync, (e) => sync.writeSyncStep2(e, next.doc)),
      frame(message.sync, (e) => sync.writeUpdate(e, next.update)),
      updateFrame("forbidden", next.update),
    ]) {
      const reader = await connect(shared.readId);
      await service.receive(reader.connection, payload);
      expect(reader.closed.at(-1)?.reason).toBe("read_only");
      expect(replies(reader.sent).at(-1)).toMatchObject({ type: "reject", code: "read_only" });
    }
    await expect(service.remove(shared.readId)).rejects.toMatchObject({ code: "read_only" });
    expect((await service.read(shared.readId)).content).toBe("hello");
  });

  test("duplicates before and after compaction do not add rows, and missing predecessors are rejected", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const client = new Y.Doc();
    client.clientID = 14;
    Y.applyUpdate(client, Y.encodeStateAsUpdate(shared.doc));
    docs.push(client);
    const vector = Y.encodeStateVector(client);
    client.getText("text").insert(5, "1");
    const first = Y.encodeStateAsUpdate(client, vector);
    const vector2 = Y.encodeStateVector(client);
    client.getText("text").insert(6, "2");
    const second = Y.encodeStateAsUpdate(client, vector2);
    await service.receive(writer.connection, updateFrame("second", second));
    expect(replies(writer.sent).at(-1)).toMatchObject({ type: "reject", code: "missing_predecessor" });
    await service.receive(writer.connection, updateFrame("first", first));
    await service.receive(writer.connection, updateFrame("first", first));
    let [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pad_updates WHERE read_id=${shared.readId}`;
    expect(row!.count).toBe(1);
    await service.receive(writer.connection, updateFrame("second", second));
    await service.compact(shared.readId);
    await service.receive(writer.connection, updateFrame("first", first));
    [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pad_updates WHERE read_id=${shared.readId}`;
    expect(row!.count).toBe(0);
    expect((await service.read(shared.readId)).content).toBe("hello12");
  });

  test("a database failure leaves the live document unchanged and sends no broadcast or ack", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const reader = await connect(shared.readId);
    const next = edit(shared.doc, 12, " next");
    await db.unsafe(
      "CREATE FUNCTION fail_notes_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test database failure'; END $$; CREATE TRIGGER fail_write BEFORE INSERT ON pad_updates FOR EACH ROW EXECUTE FUNCTION fail_notes_write()",
    );
    const before = reader.sent.length;
    const original = console.error;
    const logs: unknown[] = [];
    console.error = (entry) => {
      logs.push(entry);
    };
    try {
      await service.receive(writer.connection, updateFrame("retryable", next.update));
    } finally {
      console.error = original;
      await db.unsafe("DROP TRIGGER fail_write ON pad_updates; DROP FUNCTION fail_notes_write()");
    }
    expect(replies(writer.sent).at(-1)).toMatchObject({ type: "reject", code: "unavailable" });
    expect(reader.sent.length).toBe(before);
    expect((await service.read(shared.readId)).content).toBe("hello");
    expect(JSON.stringify(logs)).not.toContain(shared.readId);
    expect(JSON.stringify(logs)).not.toContain(shared.editId);
    expect(writer.closed.at(-1)?.reason).toBe("resync_required");
    const reconnected = await connect(shared.editId);
    await service.receive(reconnected.connection, updateFrame("retryable", next.update));
    expect((await service.read(shared.readId)).content).toBe("hello next");
  });

  test("oversized and malformed state vectors are rejected without a persistence error", async () => {
    const shared = await pad();
    const original = console.error;
    const logs: unknown[] = [];
    console.error = (entry) => {
      logs.push(entry);
    };
    try {
      for (const vector of [new Uint8Array(limits.vectorBytes + 1), new Uint8Array([128])]) {
        const reader = await connect(shared.readId);
        await service.receive(
          reader.connection,
          frame(message.sync, (e) => {
            encoding.writeVarUint(e, sync.messageYjsSyncStep1);
            encoding.writeVarUint8Array(e, vector);
          }),
        );
        expect(reader.closed.at(-1)?.reason).toBe("invalid_frame");
      }
      expect(logs).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  test("log byte limits compact insert-delete updates before the next append", async () => {
    const shared = await pad();
    let writer = await connect(shared.editId);
    const doc = new Y.Doc();
    doc.clientID = 999;
    docs.push(doc);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(shared.doc));
    for (let i = 0; i < 18; i++) {
      if (i === 9) {
        service.disconnect(writer.connection);
        writer = await connect(shared.editId);
      }
      const vector = Y.encodeStateVector(doc);
      doc.getText("text").insert(5, "x".repeat(1_000_000));
      doc.getText("text").delete(5, 1_000_000);
      await service.receive(writer.connection, updateFrame(`discard_${i}`, Y.encodeStateAsUpdate(doc, vector)));
    }
    const [row] = await db<
      { bytes: string }[]
    >`SELECT COALESCE(SUM(octet_length(update)),0)::text AS bytes FROM pad_updates WHERE read_id=${shared.readId}`;
    expect(Number(row!.bytes)).toBeLessThanOrEqual(limits.stateBytes);
    expect((await service.read(shared.readId)).content).toBe("hello");
  });

  test("a commit with a lost response reloads before later updates and compaction", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const first = edit(shared.doc, 12, " committed");
    const append = service.store.append.bind(service.store);
    service.store.append = async (...args) => {
      await append(...args);
      throw new Error("commit_response_lost");
    };
    const original = console.error;
    console.error = () => {};
    try {
      await service.receive(writer.connection, updateFrame("ambiguous", first.update));
    } finally {
      service.store.append = append;
      console.error = original;
    }
    expect(writer.closed.at(-1)?.reason).toBe("resync_required");
    const second = edit(shared.doc, 13, " concurrent");
    const reconnected = await connect(shared.editId);
    await service.receive(reconnected.connection, updateFrame("later", second.update));
    await service.compact(shared.readId);
    Y.applyUpdate(first.doc, second.update);
    expect((await service.read(shared.readId)).content).toBe(first.doc.getText("text").toString());
    const loaded = await service.store.load(shared.readId);
    expect(loaded.doc.getText("text").toString()).toBe(first.doc.getText("text").toString());
    loaded.doc.destroy();
  });

  test("a reader pulls standard sync without receiving a write challenge", async () => {
    const shared = await pad();
    const reader = await connect(shared.readId);
    expect(reader.sent.some((bytes) => decoding.readVarUint(decoding.createDecoder(bytes)) === message.sync)).toBe(false);
    const doc = new Y.Doc();
    docs.push(doc);
    await service.receive(
      reader.connection,
      frame(message.sync, (e) => sync.writeSyncStep1(e, doc)),
    );
    const response = decoding.createDecoder(reader.sent.at(-1)!);
    decoding.readVarUint(response);
    const reply = encoding.createEncoder();
    sync.readSyncMessage(response, reply, doc, null);
    expect(doc.getText("text").toString()).toBe("hello");
    expect(reader.closed).toEqual([]);
  });

  test("awareness rewrites identity, color, clock and unverified names; readers cannot publish cursors", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const reader = await connect(shared.readId);
    const cursor = { anchor: { tname: "text", item: { client: 11, clock: 0 } }, head: { tname: "text", item: { client: 11, clock: 1 } } };
    await service.receive(writer.connection, awareness(12, { user: { name: "\u202e Alice ", userId: "forged", color: "#000" }, cursor }));
    const state = decodedAwareness(reader.sent.at(-1)!);
    expect(state.id).toBe(writer.connection.awareness.id);
    expect(state.id).toBeGreaterThanOrEqual(2 ** 32);
    expect(state.clock).toBe(1);
    expect(state.state.user).toMatchObject({ name: "Alice", unverified: true, readOnly: false });
    expect(state.state.user.userId).not.toBe("forged");
    expect(state.state.user.color).not.toBe("#000");
    await service.receive(reader.connection, awareness(13, { user: { name: "Reader" }, cursor }));
    expect(decodedAwareness(writer.sent.at(-1)!).state.cursor).toBeNull();
    await service.receive(writer.connection, awareness(13, null));
    expect(writer.closed.at(-1)?.reason).toBe("invalid_awareness");
    expect(decodedAwareness(reader.sent.at(-1)!).state).toBeNull();
    expect(reader.connection.awareness.current).not.toBeNull();
  });

  test("deleting fences pending writes, closes sockets, removes data and refuses reconnects", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const next = edit(shared.doc, 12, " late");
    await Promise.all([service.remove(shared.editId), service.receive(writer.connection, updateFrame("late", next.update))]);
    expect(writer.closed.at(-1)?.reason).toBe("deleted");
    await expect(service.admit(shared.editId, "203.0.113.10")).rejects.toMatchObject({ code: "deleted" });
    const [row] = await db<{ bytes: number }[]>`SELECT octet_length(snapshot) AS bytes FROM pads WHERE read_id=${shared.readId}`;
    expect(row!.bytes).toBe(0);
    expect((await service.store.status()).usedBytes).toBe(costs.tombstone + costs.decision + 2 * Buffer.byteLength("deleted"));
  });

  test("text, state, and document type limits reject changes before persistence", async () => {
    const doc = new Y.Doc();
    doc.clientID = 17;
    docs.push(doc);
    doc.getText("text").insert(0, "x".repeat(limits.text + 1));
    await expect(service.create(Y.encodeStateAsUpdate(doc), "203.0.113.10")).rejects.toMatchObject({ code: "text_limit" });
    await expect(service.create(new Uint8Array(limits.stateBytes + 1), "203.0.113.11")).rejects.toMatchObject({ code: "state_limit" });
    const invalid = new Y.Doc();
    invalid.clientID = 18;
    docs.push(invalid);
    invalid.getMap("other").set("x", "value");
    await expect(service.create(Y.encodeStateAsUpdate(invalid), "203.0.113.12")).rejects.toMatchObject({ code: "invalid_document" });
  });

  test("storage is reserved atomically and pauses new notes before capacity", async () => {
    await service.stop();
    const budget = 2400;
    service = new NotesService(new NotesStore(db, budget), { ...options, storageBytes: budget });
    await service.start();
    const doc = initial();
    docs.push(doc);
    const bytes = Y.encodeStateAsUpdate(doc);
    const attempts = await Promise.allSettled([
      service.create(bytes, "203.0.113.1"),
      service.create(bytes, "203.0.113.2"),
      service.create(bytes, "203.0.113.3"),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled").length).toBe(2);
    expect((await service.store.status()).usedBytes).toBeLessThanOrEqual(budget);
  });

  test("connection limits return a readable snapshot and release slots on close", async () => {
    const shared = await pad();
    const connected = [];
    for (let i = 0; i < limits.peersPerPad; i++) connected.push(await connect(shared.readId, `203.0.113.${i + 1}`));
    await expect(service.admit(shared.readId, "192.0.2.200")).rejects.toMatchObject({ code: "connections_full" });
    expect((await service.read(shared.readId)).liveAvailable).toBe(false);
    service.disconnect(connected[0]!.connection);
    const next = await connect(shared.readId, "192.0.2.200");
    expect(next.connection.released).toBe(false);
  });

  test("slow recipients disconnect and can reload the committed state", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const reader = await connect(shared.readId);
    reader.buffer(limits.bufferBytes + 1);
    const next = edit(shared.doc, 12, " still saved");
    await service.receive(writer.connection, updateFrame("saved", next.update));
    expect(reader.closed.at(-1)?.reason).toBe("resync_required");
    expect((await service.read(shared.readId)).content).toBe("hello still saved");
  });

  test("GET and HEAD never refresh expiry; a separate human signal does", async () => {
    const shared = await pad();
    const app = createNotesApp(async () => true, service, { origin });
    await db`UPDATE pads SET last_human_open_on='2026-04-30' WHERE read_id=${shared.readId}`;
    for (const method of ["GET", "HEAD"]) expect((await app.request(`/api/pads/${shared.readId}`, { method })).status).toBe(200);
    const [before] = await db<{ date: string }[]>`SELECT last_human_open_on::text AS date FROM pads WHERE read_id=${shared.readId}`;
    expect(before!.date).toBe("2026-04-30");
    const request = { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ human: true }) };
    expect((await app.request(`/api/pads/${shared.readId}/opened`, request)).status).toBe(204);
    const [after] = await db<{ date: string }[]>`SELECT last_human_open_on::text AS date FROM pads WHERE read_id=${shared.readId}`;
    expect(after!.date).not.toBe(before!.date);
    await db`UPDATE pads SET last_human_open_on='2026-04-30' WHERE read_id=${shared.readId}`;
    await service.tick(FIXED.getTime());
    await expect(service.read(shared.readId)).rejects.toMatchObject({ code: "expired" });
  });

  test("a restart finishes previously marked cleanup without refreshing human activity", async () => {
    const shared = await pad();
    await service.store.mark(shared.readId, "delete", "deleted");
    await service.stop();
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    await service.tick(FIXED.getTime());
    const [row] = await db<
      { bytes: number; content_md: string }[]
    >`SELECT octet_length(snapshot) AS bytes,content_md FROM pads WHERE read_id=${shared.readId}`;
    expect(row).toEqual({ bytes: 0, content_md: "" });
    await expect(service.read(shared.editId)).rejects.toMatchObject({ code: "deleted" });
    await expect(service.admit(shared.editId, "restart")).rejects.toMatchObject({ code: "deleted" });
  });

  test("HTTP sharing contract accepts consent, returns both links, and checks Origin", async () => {
    const app = createNotesApp(async () => true, service, { origin });
    const doc = initial();
    docs.push(doc);
    const body = JSON.stringify({
      accepted: true,
      title: "untrusted title",
      snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    });
    const rejected = await app.request("/api/pads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://foreign.example" },
      body,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "origin_forbidden" });
    const response = await app.request("/api/pads", { method: "POST", headers: { "content-type": "application/json", origin }, body });
    expect(response.status).toBe(201);
    const links = await response.json();
    const read = await (await app.request(`/api/pads/${links.readId}`)).json();
    expect(read).toMatchObject({ readId: links.readId, role: "read", title: "hello", content: "hello" });
    expect(JSON.stringify(read)).not.toContain(links.editId);
    expect((await (await app.request(`/api/pads/${links.editId}`)).json()).role).toBe("edit");
  });

  test("a superseded process cannot commit updates", async () => {
    const shared = await pad();
    const writer = await connect(shared.editId);
    const next = edit(shared.doc, 12, " stale");
    const [owner] = await db<{ owner_id: string }[]>`SELECT owner_id FROM notes_storage WHERE singleton`;
    await db`UPDATE notes_storage SET owner_id='replacement-process' WHERE singleton`;
    const original = console.error;
    console.error = () => {};
    try {
      await service.receive(writer.connection, updateFrame("stale", next.update));
    } finally {
      console.error = original;
      await db`UPDATE notes_storage SET owner_id=${owner!.owner_id} WHERE singleton`;
    }
    expect(replies(writer.sent).at(-1)).toMatchObject({ type: "reject", code: "unavailable" });
    expect((await service.read(shared.readId)).content).toBe("hello");
  });

  test("real WebSockets exchange standard Yjs sync and commit acknowledgements", async () => {
    const shared = await pad();
    await service.stop();
    const runtime = await serveNotes(new SQL(database.url), { ...options, origin, port: 0, hostname: "127.0.0.1" });
    service = runtime.service;
    const sockets: WebSocket[] = [];
    const open = async (token: string) => {
      const socket = new BunSocket(`ws://127.0.0.1:${runtime.server.port}/api/pads/${token}/ws`, { headers: { Origin: origin } });
      sockets.push(socket);
      socket.binaryType = "arraybuffer";
      const received: Uint8Array[] = [];
      socket.addEventListener("message", (event) => {
        received.push(new Uint8Array(event.data));
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("socket_open_failed")), { once: true });
      });
      const take = async (type: number) => {
        const deadline = performance.now() + 2_000;
        while (performance.now() < deadline) {
          const index = received.findIndex((bytes) => decoding.readVarUint(decoding.createDecoder(bytes)) === type);
          if (index !== -1) return received.splice(index, 1)[0]!;
          await Bun.sleep(5);
        }
        throw new Error("socket_frame_missing");
      };
      return { socket, take };
    };
    try {
      const writer = await open(shared.editId);
      const reader = await open(shared.readId);
      await writer.take(message.sync);
      await reader.take(message.identity);
      const empty = new Y.Doc();
      empty.clientID = 99;
      docs.push(empty);
      reader.socket.send(Uint8Array.from(frame(message.sync, (e) => sync.writeSyncStep1(e, empty))).buffer);
      const step = decoding.createDecoder(await reader.take(message.sync));
      expect(decoding.readVarUint(step)).toBe(message.sync);
      expect(decoding.readVarUint(step)).toBe(sync.messageYjsSyncStep2);
      Y.applyUpdate(empty, decoding.readVarUint8Array(step));
      expect(empty.getText("text").toString()).toBe("hello");
      const next = edit(shared.doc, 12, " wire");
      writer.socket.send(Uint8Array.from(updateFrame("wire", next.update)).buffer);
      expect(readReply(await writer.take(message.ack))).toEqual({ type: "ack", id: "wire" });
      const update = decoding.createDecoder(await reader.take(message.sync));
      decoding.readVarUint(update);
      expect(decoding.readVarUint(update)).toBe(sync.messageYjsUpdate);
      Y.applyUpdate(empty, decoding.readVarUint8Array(update));
      expect(empty.getText("text").toString()).toBe("hello wire");
      expect((await service.read(shared.readId)).content).toBe("hello wire");
    } finally {
      for (const socket of sockets) socket.close();
      await runtime.stop();
    }
  });

  test("crash after commit and before acknowledgement recovers the accepted update", async () => {
    const shared = await pad();
    await service.stop();
    const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/sync-crash.worker.ts`], {
      env: {
        ...process.env,
        CLOUD_TEST_DATABASE_URL: database.url,
        NOTES_TEST_EDIT_ID: shared.editId,
        NOTES_TEST_CRASH: "ack",
        BUN_OPTIONS: "--no-env-file",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await child.exited).not.toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
    await waitForCrashedOwner();
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    expect((await service.read(shared.readId)).content).toBe("hello crash-safe");
  });

  test("a crash during compaction rolls back both the snapshot and log deletion", async () => {
    const shared = await pad();
    await service.stop();
    const blocker = await db.reserve();
    await blocker`SELECT pg_advisory_lock(726628315)`;
    await db.unsafe(
      "CREATE FUNCTION pause_notes_compaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(726628315); RETURN OLD; END $$; CREATE TRIGGER pause_compaction BEFORE DELETE ON pad_updates FOR EACH ROW EXECUTE FUNCTION pause_notes_compaction()",
    );
    const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/sync-crash.worker.ts`], {
      env: {
        ...process.env,
        CLOUD_TEST_DATABASE_URL: database.url,
        NOTES_TEST_EDIT_ID: shared.editId,
        NOTES_TEST_CRASH: "compact",
        BUN_OPTIONS: "--no-env-file",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = performance.now() + 2_000;
      let waiting = 0;
      while (performance.now() < deadline) {
        const [row] = await db<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=726628315 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
        waiting = row!.count;
        if (waiting === 1 || child.exitCode !== null) break;
        await Bun.sleep(10);
      }
      expect(waiting).toBe(1);
      child.kill("SIGKILL");
      await child.exited;
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await blocker`SELECT pg_advisory_unlock(726628315)`;
      blocker.release();
      await db.unsafe("DROP TRIGGER pause_compaction ON pad_updates; DROP FUNCTION pause_notes_compaction()");
    }
    const [row] = await db<
      { through: string; count: number }[]
    >`SELECT applied_through::text AS through,(SELECT count(*)::int FROM pad_updates WHERE read_id=${shared.readId}) AS count FROM pads WHERE read_id=${shared.readId}`;
    expect(row).toEqual({ through: "0", count: 1 });
    await waitForCrashedOwner();
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    expect((await service.read(shared.readId)).content).toBe("hello crash-safe");
  });
});

test("sliding windows are independent, weighted, and bounded", () => {
  let now = 1_000;
  const rate = new RateLimits(() => now, 3);
  rate.take("create", "ip", 2, 1_000);
  rate.take("create", "ip", 2, 1_000);
  expect(() => rate.take("create", "ip", 2, 1_000)).toThrow("rate_limited");
  rate.take("upload", "ip", 10, 1_000, 10);
  expect(() => rate.take("upload", "ip", 10, 1_000)).toThrow("rate_limited");
  now += 1_000;
  expect(() => rate.take("create", "ip", 2, 1_000)).not.toThrow();
});

test("forwarded addresses are honored only from the configured immediate proxy", () => {
  expect(requestIp("192.0.2.1", "203.0.113.2", "192.0.2.9")).toBe("192.0.2.1");
  expect(requestIp("192.0.2.9", "198.51.100.1, 203.0.113.2", "192.0.2.9")).toBe("203.0.113.2");
  expect(requestIp("192.0.2.9", "invalid", "192.0.2.9")).toBe("192.0.2.9");
});

test("mapped proxy peers and rotating IPv6 addresses share stable connection keys", () => {
  expect(requestIp("::ffff:127.0.0.1", "192.0.2.4", "127.0.0.1")).toBe("192.0.2.4");
  expect(requestIp("127.0.0.1", "192.0.2.4", "::ffff:127.0.0.1")).toBe("192.0.2.4");
  expect(rateKey("2001:db8:1:2:aaaa:bbbb:cccc:1")).toBe(rateKey("2001:db8:1:2::2"));
  expect(rateKey("2001:db8:1:3::2")).not.toBe(rateKey("2001:db8:1:2::2"));
  const rates = new RateLimits(() => 0, 2);
  rates.take("create", "192.0.2.1", 1, 3600000);
  rates.take("create", "192.0.2.2", 1, 3600000);
  expect(() => rates.take("connect", "192.0.2.3", 1, 60000)).not.toThrow();
});

test("NUL text cannot enter a durable document whose Postgres projection would fail", () => {
  const doc = new Y.Doc();
  doc.clientID = 42;
  try {
    doc.getText("text").insert(0, "before\u0000after");
    expect(() => decodeDocument(Y.encodeStateAsUpdate(doc))).toThrow("invalid_document");
  } finally {
    doc.destroy();
  }
});
