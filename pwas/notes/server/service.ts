import { randomInt } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { ackFrame, frame, message, rejectFrame } from "../protocol";
import { SocketAwareness } from "./awareness";
import { validateDocument } from "./document";
import { NotesError } from "./errors";
import type { CheckedFile } from "./files";
import { limits, RateLimits } from "./limits";
import type { NotesStore } from "./store";
import { hash } from "./tokens";

const read = <T>(decode: () => T): T => {
  try {
    return decode();
  } catch {
    throw new NotesError("invalid_frame");
  }
};

type Room = { doc: Y.Doc; through: string; updates: number; logBytes: number; peers: Set<Connection>; touched: number; changed: number };
type Queue = { tail: Promise<unknown>; pending: number };
export type Peer = {
  send: (bytes: Uint8Array) => void;
  close: (code: number, reason: string) => void;
  bufferedAmount: () => number;
  ping?: () => void;
};
export type Connection = {
  readId: string;
  access: "read" | "edit";
  ip: string;
  peer?: Peer;
  awareness: SocketAwareness;
  released: boolean;
  lastPong: number;
  pendingMessages: number;
  pendingBytes: number;
  rates: RateLimits;
};
export type NotesOptions = { storageBytes: number; maxConnections: number; maxOpenPads: number };

export class NotesService {
  readonly rates = new RateLimits();
  readonly store: NotesStore;
  private readonly rooms = new Map<string, Room>();
  private readonly queues = new Map<string, Queue>();
  private readonly connections = new Set<Connection>();
  private readonly ipConnections = new Map<string, number>();
  private readonly padConnections = new Map<string, number>();
  private loadingRooms = 0;
  private reading = 0;
  private nextAwarenessId = randomInt(2 ** 32, 2 ** 48);
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  maintenanceError: string | null = null;
  constructor(
    store: NotesStore,
    readonly options: NotesOptions,
  ) {
    this.store = store;
  }
  async start(): Promise<void> {
    await this.store.start();
    this.timer = setInterval(() => {
      if (this.maintenance) return;
      this.maintenance = this.tick()
        .catch(() => {
          this.maintenanceError = "maintenance_failed";
          console.error("[notes] maintenance_failed");
        })
        .finally(() => {
          this.maintenance = undefined;
        });
    }, limits.heartbeatMs);
    this.timer.unref();
  }
  private enqueue<T>(readId: string, run: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(readId);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0 };
      this.queues.set(readId, queue);
    }
    if (queue.pending >= limits.queuePerPad) return Promise.reject(new NotesError("overloaded", 429));
    queue.pending++;
    const active = queue;
    const result = active.tail.then(run);
    active.tail = result
      .catch(() => {})
      .finally(() => {
        active.pending--;
        if (active.pending === 0 && !this.rooms.has(readId)) this.queues.delete(readId);
      });
    return result;
  }
  private async room(readId: string): Promise<Room> {
    let room = this.rooms.get(readId);
    if (room) return room;
    if (this.rooms.size + this.loadingRooms >= this.options.maxOpenPads) throw new NotesError("rooms_full", 429);
    this.loadingRooms++;
    let loaded: Awaited<ReturnType<NotesStore["load"]>>;
    try {
      loaded = await this.store.load(readId);
    } finally {
      this.loadingRooms--;
    }
    room = { ...loaded, peers: new Set(), touched: Date.now(), changed: Date.now() };
    this.rooms.set(readId, room);
    return room;
  }
  async create(bytes: Uint8Array, ip: string) {
    if (this.stopping) throw new NotesError("unavailable", 503);
    this.rates.take("create", ip, limits.createPerHour, 3_600_000);
    return this.store.create(bytes);
  }
  async read(token: string, ip?: string) {
    if (ip) this.rates.take("read", ip, limits.peersPerPad, 60_000);
    if (!(await this.store.ownsDatabase())) throw new NotesError("unavailable", 503);
    const access = await this.store.resolve(token);
    if (this.reading >= this.options.maxOpenPads) throw new NotesError("overloaded", 429);
    this.reading++;
    let loaded: Awaited<ReturnType<NotesStore["load"]>> | undefined;
    try {
      const cached = this.rooms.get(access.readId);
      if (!cached) loaded = await this.store.load(access.readId);
      const doc = cached?.doc ?? loaded!.doc;
      const content = doc.getText("text").toString();
      return {
        readId: access.readId,
        role: access.access,
        title:
          content
            .split("\n")
            .find((line) => line.trim())
            ?.replace(/^#{1,6}\s+/, "")
            .slice(0, 200) ?? "",
        snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
        content,
        status: "active" as const,
        liveAvailable: (this.padConnections.get(access.readId) ?? 0) < limits.peersPerPad,
      };
    } finally {
      this.reading--;
      loaded?.doc.destroy();
    }
  }
  async upload(token: string, file: CheckedFile): Promise<{ key: string }> {
    if (this.stopping) throw new NotesError("unavailable", 503);
    const access = await this.store.resolve(token);
    if (access.access !== "edit") throw new NotesError("read_only", 403);
    return this.enqueue(access.readId, () => this.store.putFile(access.readId, file));
  }
  async humanOpen(token: string, ip: string): Promise<void> {
    this.rates.take("open", ip, limits.createPerHour * limits.peersPerIp, 3_600_000);
    const access = await this.store.resolve(token);
    await this.enqueue(access.readId, () => this.store.humanOpen(access.readId));
  }
  async admit(token: string, ip: string): Promise<Connection> {
    if (this.stopping) throw new NotesError("unavailable", 503);
    this.rates.take("connect", ip, limits.peersPerIp, 60_000);
    if (!(await this.store.ownsDatabase())) throw new NotesError("unavailable", 503);
    const access = await this.store.resolve(token);
    if (this.stopping) throw new NotesError("unavailable", 503);
    const ipCount = this.ipConnections.get(ip) ?? 0;
    const padCount = this.padConnections.get(access.readId) ?? 0;
    if (ipCount >= limits.peersPerIp || padCount >= limits.peersPerPad || this.connections.size >= this.options.maxConnections)
      throw new NotesError("connections_full", 429);
    const connection: Connection = {
      ...access,
      ip,
      awareness: new SocketAwareness(this.nextAwarenessId++, access.access === "read"),
      released: false,
      lastPong: Date.now(),
      pendingMessages: 0,
      pendingBytes: 0,
      rates: new RateLimits(Date.now, 3),
    };
    this.connections.add(connection);
    this.ipConnections.set(ip, ipCount + 1);
    this.padConnections.set(access.readId, padCount + 1);
    try {
      await this.enqueue(access.readId, () => this.room(access.readId));
      return connection;
    } catch (error) {
      this.release(connection);
      throw error;
    }
  }
  async attach(connection: Connection, peer: Peer): Promise<void> {
    connection.peer = peer;
    try {
      await this.enqueue(connection.readId, async () => {
        if (connection.released || this.stopping) throw new NotesError("unavailable", 503);
        const room = await this.room(connection.readId);
        room.peers.add(connection);
        room.touched = Date.now();
        this.send(
          connection,
          frame(message.identity, (e) => encoding.writeVarUint(e, connection.awareness.id)),
        );
        if (connection.access === "edit")
          this.send(
            connection,
            frame(message.sync, (e) => sync.writeSyncStep1(e, room.doc)),
          );
        for (const other of room.peers)
          if (other.awareness.current)
            this.send(
              connection,
              frame(message.awareness, (e) => encoding.writeVarUint8Array(e, other.awareness.current!)),
            );
      });
    } catch (error) {
      this.disconnect(connection);
      throw error;
    }
  }
  private send(connection: Connection, bytes: Uint8Array): void {
    if (connection.released || !connection.peer) return;
    try {
      if (connection.peer.bufferedAmount() > limits.bufferBytes) {
        this.disconnect(connection, 1013, "resync_required");
        return;
      }
      connection.peer.send(bytes);
    } catch {
      this.disconnect(connection, 1013, "resync_required");
    }
  }
  private broadcast(room: Room, bytes: Uint8Array, except?: Connection): void {
    for (const peer of room.peers) if (peer !== except) this.send(peer, bytes);
  }
  async receive(connection: Connection, bytes: Uint8Array): Promise<void> {
    if (connection.released) return;
    let updateId = "";
    let counted = false;
    try {
      if (this.stopping) throw new NotesError("unavailable", 503);
      if (bytes.byteLength > limits.stateBytes + 256) throw new NotesError("state_limit", 413);
      connection.rates.take("messages", "socket", limits.messagesPerSecond, 1_000);
      // One full document plus the planned two 200-byte updates/s is admitted per second.
      connection.rates.take("bytes", "socket", limits.stateBytes + limits.messagesPerSecond * 200, 1_000, bytes.byteLength);
      connection.pendingMessages++;
      connection.pendingBytes += bytes.byteLength;
      counted = true;
      if (connection.pendingMessages > limits.messagesPerSecond || connection.pendingBytes > limits.stateBytes + 256)
        throw new NotesError("overloaded", 429);
      const decoder = decoding.createDecoder(bytes);
      const type = read(() => decoding.readVarUint(decoder));
      if (type === message.update) {
        if (connection.access !== "edit") throw new NotesError("read_only", 403);
        updateId = read(() => decoding.readVarString(decoder));
        if (!/^[\x21-\x7e]{1,128}$/.test(updateId)) throw new NotesError("invalid_frame");
        const update = read(() => decoding.readVarUint8Array(decoder));
        if (decoder.pos !== bytes.length) throw new NotesError("invalid_frame");
        await this.enqueue(connection.readId, () => this.apply(connection, updateId, update));
      } else if (type === message.sync) {
        const subtype = read(() => decoding.readVarUint(decoder));
        if (subtype === sync.messageYjsSyncStep1) {
          const vector = read(() => decoding.readVarUint8Array(decoder));
          if (decoder.pos !== bytes.length || vector.byteLength > limits.vectorBytes) throw new NotesError("invalid_frame");
          read(() => Y.decodeStateVector(vector));
          await this.enqueue(connection.readId, async () => {
            const room = await this.room(connection.readId);
            this.send(
              connection,
              frame(message.sync, (e) => sync.writeSyncStep2(e, room.doc, vector)),
            );
          });
        } else if (subtype === sync.messageYjsSyncStep2 || subtype === sync.messageYjsUpdate) {
          if (connection.access !== "edit") throw new NotesError("read_only", 403);
          const update = read(() => decoding.readVarUint8Array(decoder));
          if (decoder.pos !== bytes.length) throw new NotesError("invalid_frame");
          updateId = `standard:${hash(update)}`;
          await this.enqueue(connection.readId, () => this.apply(connection, updateId, update));
        } else throw new NotesError("invalid_frame");
      } else if (type === message.awareness) {
        connection.rates.take("awareness", "socket", limits.awarenessPerSecond, 1_000);
        const awareness = read(() => decoding.readVarUint8Array(decoder));
        if (decoder.pos !== bytes.length) throw new NotesError("invalid_frame");
        await this.enqueue(connection.readId, async () => {
          const room = await this.room(connection.readId);
          if (connection.released) return;
          const trusted = connection.awareness.publish(awareness);
          this.broadcast(
            room,
            frame(message.awareness, (e) => encoding.writeVarUint8Array(e, trusted)),
          );
        });
      } else if (type === message.queryAwareness && decoder.pos === bytes.length) {
        const room = this.rooms.get(connection.readId);
        for (const peer of room?.peers ?? [])
          if (peer.awareness.current)
            this.send(
              connection,
              frame(message.awareness, (e) => encoding.writeVarUint8Array(e, peer.awareness.current!)),
            );
      } else throw new NotesError("invalid_frame");
    } catch (error) {
      const code = error instanceof NotesError ? error.code : "unavailable";
      if (!(error instanceof NotesError)) console.error("[notes] sync_failed");
      this.send(connection, rejectFrame(updateId, code));
      if (["read_only", "invalid_frame", "state_limit", "overloaded", "rate_limited", "invalid_awareness"].includes(code))
        this.disconnect(connection, code === "read_only" ? 1008 : 1013, code);
    } finally {
      if (counted) {
        connection.pendingMessages--;
        connection.pendingBytes -= bytes.byteLength;
      }
    }
  }
  private async apply(connection: Connection, id: string, bytes: Uint8Array): Promise<void> {
    if (connection.released) return;
    const room = await this.room(connection.readId);
    const candidate = new Y.Doc();
    let committed = false;
    try {
      const before = Y.encodeStateAsUpdate(room.doc);
      Y.applyUpdate(candidate, before);
      const started = performance.now();
      try {
        Y.applyUpdate(candidate, bytes);
      } catch {
        throw new NotesError("invalid_document");
      }
      const after = validateDocument(candidate, started);
      if (Buffer.from(before).equals(after)) {
        this.send(connection, ackFrame(id));
        return;
      }
      if (room.logBytes + bytes.byteLength > limits.stateBytes) await this.compactRoom(connection.readId, room);
      let result: Awaited<ReturnType<NotesStore["append"]>>;
      try {
        result = await this.store.append(connection.readId, id, bytes);
      } catch (error) {
        if (!(error instanceof NotesError) || error.code === "unavailable") {
          // COMMIT may have succeeded. Never compact this possibly stale room again.
          this.send(connection, rejectFrame(id, "unavailable"));
          this.invalidate(connection.readId);
        }
        throw error;
      }
      committed = true;
      const previous = room.doc;
      room.doc = candidate;
      if (BigInt(result.id) > BigInt(room.through)) room.through = result.id;
      room.updates += result.duplicate ? 0 : 1;
      room.logBytes += result.duplicate ? 0 : bytes.byteLength;
      room.changed = room.touched = Date.now();
      previous.destroy();
      this.broadcast(
        room,
        frame(message.sync, (e) => sync.writeUpdate(e, bytes)),
        connection,
      );
      this.send(connection, ackFrame(id));
      if (room.updates >= limits.compactUpdates || room.logBytes >= limits.stateBytes) {
        try {
          await this.compactRoom(connection.readId, room);
        } catch {
          this.maintenanceError = "compaction_failed";
          console.error("[notes] compaction_failed");
        }
      }
    } finally {
      if (!committed) candidate.destroy();
    }
  }
  async compact(readId: string): Promise<void> {
    await this.enqueue(readId, async () => {
      const room = this.rooms.get(readId);
      if (room) await this.compactRoom(readId, room);
    });
  }
  private async compactRoom(readId: string, room: Room): Promise<void> {
    if (!room.updates) return;
    await this.store.compact(readId, Y.encodeStateAsUpdate(room.doc), room.through, room.doc.getText("text").toString());
    room.updates = 0;
    room.logBytes = 0;
  }
  private release(connection: Connection): void {
    if (connection.released) return;
    connection.released = true;
    this.connections.delete(connection);
    for (const [map, key] of [
      [this.ipConnections, connection.ip],
      [this.padConnections, connection.readId],
    ] as const) {
      const count = (map.get(key) ?? 1) - 1;
      if (count <= 0) map.delete(key);
      else map.set(key, count);
    }
  }
  disconnect(connection: Connection, code = 1000, reason = "closed"): void {
    if (connection.released) return;
    this.release(connection);
    const room = this.rooms.get(connection.readId);
    room?.peers.delete(connection);
    if (room) {
      room.touched = Date.now();
      const removed = connection.awareness.remove();
      if (removed)
        this.broadcast(
          room,
          frame(message.awareness, (e) => encoding.writeVarUint8Array(e, removed)),
        );
    }
    try {
      connection.peer?.close(code, reason);
    } catch {}
  }
  pong(connection: Connection): void {
    connection.lastPong = Date.now();
  }
  async remove(token: string): Promise<void> {
    const access = await this.store.resolve(token);
    if (access.access !== "edit") throw new NotesError("read_only", 403);
    await this.removeReadId(access.readId, "delete", "deleted");
  }
  private invalidate(readId: string, reason = "resync_required"): void {
    const room = this.rooms.get(readId);
    for (const peer of [...(room?.peers ?? [])]) this.disconnect(peer, 1013, reason);
    room?.doc.destroy();
    this.rooms.delete(readId);
  }
  async removeReadId(readId: string, kind: "delete" | "block" | "expire", reason: string, today?: string): Promise<void> {
    await this.enqueue(readId, async () => {
      if (!(await this.store.mark(readId, kind, reason, today))) return;
      this.invalidate(readId, kind === "block" ? "blocked" : kind === "expire" ? "expired" : "deleted");
      await this.store.cleanup(readId);
    });
  }
  async tick(now = Date.now()): Promise<void> {
    if (!(await this.store.ownsDatabase())) {
      for (const readId of this.rooms.keys()) this.invalidate(readId);
      throw new NotesError("unavailable", 503);
    }
    this.rates.prune();
    for (const connection of this.connections) {
      if (now - connection.lastPong >= limits.heartbeatMs * 2) {
        this.disconnect(connection, 1013, "heartbeat_timeout");
        continue;
      }
      try {
        connection.peer?.ping?.();
      } catch {
        this.disconnect(connection, 1013, "resync_required");
      }
    }
    let failed = false;
    const maintain = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch {
        failed = true;
        console.error("[notes] maintenance_item_failed");
      }
    };
    for (const [readId] of this.rooms)
      await maintain(() =>
        this.enqueue(readId, async () => {
          const room = this.rooms.get(readId);
          if (!room) return;
          if (room.updates && now - room.changed >= limits.compactIdleMs) await this.compactRoom(readId, room);
          if (!room.peers.size && (this.padConnections.get(readId) ?? 0) === 0 && now - room.touched >= limits.evictIdleMs) {
            await this.compactRoom(readId, room);
            room.doc.destroy();
            this.rooms.delete(readId);
          }
        }),
      );
    // One bounded batch per tick; startup repeats the same sweep after a restart.
    for (const readId of await this.store.expired(new Date(now).toISOString().slice(0, 10), limits.peersPerPad))
      await maintain(() => this.removeReadId(readId, "expire", "expired", new Date(now).toISOString().slice(0, 10)));
    for (const readId of await this.store.pendingCleanup(limits.peersPerPad))
      await maintain(() => this.enqueue(readId, () => this.store.cleanup(readId)));
    this.maintenanceError = failed ? "maintenance_failed" : null;
  }
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    await this.maintenance;
    await Promise.all([...this.queues.values()].map((queue) => queue.tail));
    for (const connection of [...this.connections]) this.disconnect(connection, 1012, "restart");
    try {
      for (const [readId, room] of this.rooms) {
        await this.compactRoom(readId, room);
      }
    } finally {
      for (const room of this.rooms.values()) room.doc.destroy();
      this.rooms.clear();
      await this.store.stop();
    }
  }
}
