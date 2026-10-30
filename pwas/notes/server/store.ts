import type { SQL, TransactionSQL } from "bun";
import * as Y from "yjs";
import { decodeDocument } from "./document";
import { NotesError } from "./errors";
import type { CheckedFile } from "./files";
import { limits } from "./limits";
import { hash, randomId, validId } from "./tokens";

type Transaction = TransactionSQL;
export type PadAccess = { readId: string; access: "read" | "edit" };
export type PadRow = {
  read_id: string;
  snapshot: Uint8Array;
  applied_through: string;
  content_md: string;
  size_bytes: string;
  blocked_at: Date | null;
  deleted_at: Date | null;
  status_reason: string | null;
};
export const costs = { pad: 1024, update: 256, file: 512, preview: 512, report: 1024, session: 256, decision: 512 } as const;
export const textBytes = (value: string): number => Buffer.byteLength(value, "utf8");

export class NotesStore {
  private owner = randomId();
  private usedBytes = 0;
  private uncertain = false;
  private recovery?: Promise<void>;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly releases = new Map<Transaction, { positive: number; negative: number }>();
  private lease?: Awaited<ReturnType<SQL["reserve"]>>;
  constructor(
    readonly db: SQL,
    readonly storageBytes: number,
  ) {
    if (!Number.isSafeInteger(storageBytes) || storageBytes <= 0) throw new Error("invalid_storage_budget");
  }
  async start(): Promise<void> {
    const lease = await this.db.reserve();
    try {
      const [row] = await lease<{ held: boolean }[]>`SELECT pg_try_advisory_lock(726628314) AS held`;
      if (!row?.held) throw new Error("notes_already_running");
      await lease`UPDATE notes_storage SET owner_id=${this.owner} WHERE singleton`;
      this.lease = lease;
      await this.measure();
    } catch (error) {
      try {
        await lease`SELECT pg_advisory_unlock(726628314)`;
      } catch {}
      this.lease = undefined;
      lease.release();
      throw error;
    }
  }
  async stop(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    if (!lease) return;
    try {
      await lease`SELECT pg_advisory_unlock(726628314)`;
    } finally {
      lease.release();
    }
  }
  private async measure(): Promise<void> {
    const [row] = await this.db<
      { bytes: string }[]
    >`SELECT ((SELECT COALESCE(SUM(size_bytes),0) FROM pads)+(SELECT COALESCE(SUM(storage_bytes),0) FROM reports)+(SELECT COALESCE(SUM(storage_bytes),0) FROM moderation_log)+(SELECT COALESCE(SUM(storage_bytes),0) FROM admin_sessions))::text AS bytes`;
    this.usedBytes = Number(row!.bytes);
  }
  private async reconcile(): Promise<void> {
    if (!this.uncertain) return;
    this.recovery ??= (async () => {
      // New transactions wait here. Negative reservations are released only after commit.
      await Promise.allSettled([...this.inflight]);
      await this.measure();
      this.uncertain = false;
    })().finally(() => {
      this.recovery = undefined;
    });
    await this.recovery;
  }
  async ownsDatabase(): Promise<boolean> {
    if (!this.lease) return false;
    const [row] = await this.db<{ owner_id: string }[]>`SELECT owner_id FROM notes_storage WHERE singleton`;
    return row?.owner_id === this.owner;
  }
  /** Shared owner locks let independent notes commit concurrently while fencing takeover. */
  async transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    do {
      await this.reconcile();
    } while (this.uncertain);
    if (!this.lease) throw new NotesError("unavailable", 503);
    let completed = false;
    const reservation = { positive: 0, negative: 0 };
    const pending = this.db.begin(async (tx) => {
      const [row] = await tx<{ owner_id: string }[]>`SELECT owner_id FROM notes_storage WHERE singleton FOR SHARE`;
      if (row?.owner_id !== this.owner) throw new NotesError("unavailable", 503);
      this.releases.set(tx, reservation);
      try {
        const result = await run(tx);
        completed = true;
        return { result, release: reservation.negative };
      } finally {
        this.releases.delete(tx);
      }
    });
    this.inflight.add(pending);
    try {
      const { result, release } = await pending;
      this.usedBytes -= release;
      return result;
    } catch (error) {
      // Even a rejected COMMIT can have reached Postgres. Recount after all active writes.
      if (completed) this.uncertain = true;
      else this.usedBytes -= reservation.positive;
      throw error;
    } finally {
      this.inflight.delete(pending);
    }
  }
  async reserve(tx: Transaction, delta: number, kind: "new" | "existing" = "existing"): Promise<void> {
    const threshold = kind === "new" ? Math.floor(this.storageBytes * 0.9) : this.storageBytes;
    if (delta > 0 && this.usedBytes + delta > threshold) throw new NotesError("storage_full", 507);
    const reservation = this.releases.get(tx);
    if (!reservation) throw new Error("reservation_outside_transaction");
    if (delta > 0) {
      this.usedBytes += delta;
      reservation.positive += delta;
    } else reservation.negative -= delta;
  }
  async status(): Promise<{ usedBytes: number; capacityBytes: number; sharingPaused: boolean; full: boolean }> {
    await this.reconcile();
    return {
      usedBytes: this.usedBytes,
      capacityBytes: this.storageBytes,
      sharingPaused: this.usedBytes >= Math.floor(this.storageBytes * 0.9),
      full: this.usedBytes >= this.storageBytes,
    };
  }
  async resolve(token: string): Promise<PadAccess> {
    if (!validId(token)) throw new NotesError("not_found", 404);
    const [row] = await this.db<
      { read_id: string; can_edit: boolean }[]
    >`SELECT read_id, edit_id_hash=${hash(token)} AS can_edit FROM pads WHERE read_id=${token} OR edit_id_hash=${hash(token)}`;
    if (!row) throw new NotesError("not_found", 404);
    return { readId: row.read_id, access: row.can_edit ? "edit" : "read" };
  }
  async editablePad(token: string): Promise<PadAccess> {
    const access = await this.resolve(token);
    if (access.access !== "edit") throw new NotesError("read_only", 403);
    const [row] = await this.db<PadRow[]>`SELECT blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${access.readId}`;
    this.assertActive(row);
    return access;
  }
  assertActive(row: Pick<PadRow, "blocked_at" | "deleted_at" | "status_reason"> | undefined): void {
    if (!row) throw new NotesError("not_found", 404);
    if (row.blocked_at) throw new NotesError("blocked", 451, row.status_reason ?? undefined);
    if (row.deleted_at) throw new NotesError(row.status_reason === "expired" ? "expired" : "deleted", 410);
  }
  async create(bytes: Uint8Array): Promise<{ readId: string; editId: string }> {
    const doc = decodeDocument(bytes);
    try {
      const snapshot = Y.encodeStateAsUpdate(doc);
      const content = doc.getText("text").toString();
      const readId = randomId();
      let editId = randomId();
      while (editId === readId) editId = randomId();
      const size = costs.pad + snapshot.byteLength + textBytes(content);
      await this.transaction(async (tx) => {
        await this.reserve(tx, size, "new");
        await tx`INSERT INTO pads(read_id,edit_id_hash,snapshot,content_md,size_bytes) VALUES(${readId},${hash(editId)},${Buffer.from(snapshot)},${content},${size})`;
      });
      return { readId, editId };
    } finally {
      doc.destroy();
    }
  }
  async load(readId: string): Promise<{ doc: Y.Doc; through: string; updates: number; logBytes: number }> {
    return this.db.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
      const [row] = await tx<
        PadRow[]
      >`SELECT read_id,snapshot,applied_through::text,content_md,size_bytes::text,blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${readId}`;
      this.assertActive(row);
      const doc = decodeDocument(row!.snapshot);
      try {
        const updates = await tx<
          { id: string; update: Uint8Array }[]
        >`SELECT id::text,update FROM pad_updates WHERE read_id=${readId} AND id>${row!.applied_through} ORDER BY id`;
        for (const update of updates) Y.applyUpdate(doc, update.update);
        return {
          doc,
          through: updates.at(-1)?.id ?? row!.applied_through,
          updates: updates.length,
          logBytes: updates.reduce((sum, update) => sum + update.update.byteLength, 0),
        };
      } catch (error) {
        doc.destroy();
        throw error;
      }
    });
  }
  async append(readId: string, id: string, update: Uint8Array): Promise<{ id: string; duplicate: boolean }> {
    return this.transaction(async (tx) => {
      const [pad] = await tx<PadRow[]>`SELECT blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${readId} FOR UPDATE`;
      this.assertActive(pad);
      const [previous] = await tx<
        { id: string; update: Uint8Array }[]
      >`SELECT id::text,update FROM pad_updates WHERE read_id=${readId} AND client_update_id=${id}`;
      if (previous) {
        if (!Buffer.from(previous.update).equals(update)) throw new NotesError("update_id_conflict", 409);
        return { id: previous.id, duplicate: true };
      }
      const cost = costs.update + update.byteLength;
      await this.reserve(tx, cost);
      const [row] = await tx<
        { id: string }[]
      >`INSERT INTO pad_updates(read_id,client_update_id,update) VALUES(${readId},${id},${Buffer.from(update)}) ON CONFLICT(read_id,client_update_id) DO NOTHING RETURNING id::text`;
      if (!row) throw new NotesError("update_id_conflict", 409);
      await tx`UPDATE pads SET size_bytes=size_bytes+${cost} WHERE read_id=${readId}`;
      return { id: row.id, duplicate: false };
    });
  }
  async compact(readId: string, snapshot: Uint8Array, through: string, content: string): Promise<void> {
    await this.transaction(async (tx) => {
      const [pad] = await tx<
        (PadRow & { snapshot_bytes: number; content_bytes: number })[]
      >`SELECT octet_length(snapshot) AS snapshot_bytes,octet_length(content_md) AS content_bytes,blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${readId} FOR UPDATE`;
      this.assertActive(pad);
      const [log] = await tx<
        { bytes: string }[]
      >`SELECT COALESCE(SUM(octet_length(update)+${costs.update}),0)::text AS bytes FROM pad_updates WHERE read_id=${readId} AND id<=${through}`;
      const delta = snapshot.byteLength - pad!.snapshot_bytes - Number(log!.bytes) + textBytes(content) - pad!.content_bytes;
      await this.reserve(tx, delta);
      await tx`UPDATE pads SET snapshot=${Buffer.from(snapshot)},content_md=${content},applied_through=${through},size_bytes=size_bytes+${delta} WHERE read_id=${readId}`;
      await tx`DELETE FROM pad_updates WHERE read_id=${readId} AND id<=${through}`;
    });
  }
  async putFile(readId: string, file: CheckedFile): Promise<{ key: string }> {
    return this.transaction(async (tx) => {
      const [pad] = await tx<PadRow[]>`SELECT blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${readId} FOR UPDATE`;
      this.assertActive(pad);
      const [previous] = await tx<{ bytes: Uint8Array }[]>`SELECT bytes FROM pad_files WHERE read_id=${readId} AND key=${file.key}`;
      if (previous) {
        if (!Buffer.from(previous.bytes).equals(file.bytes)) throw new NotesError("file_key_conflict", 409);
        return { key: file.key };
      }
      const [row] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM pad_files WHERE read_id=${readId}`;
      if (row!.count >= limits.files) throw new NotesError("too_many_files", 409);
      const cost =
        costs.file +
        file.bytes.byteLength +
        textBytes(file.name) +
        textBytes(file.key) +
        textBytes(file.type) +
        textBytes(file.declaredType);
      await this.reserve(tx, cost, "new");
      await tx`INSERT INTO pad_files(read_id,key,name,bytes,type,checked_type) VALUES(${readId},${file.key},${file.name},${Buffer.from(file.bytes)},${file.declaredType},${file.type})`;
      await tx`UPDATE pads SET size_bytes=size_bytes+${cost} WHERE read_id=${readId}`;
      return { key: file.key };
    });
  }
  async getFile(token: string, key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string; type: string }> {
    const access = await this.resolve(token);
    return this.db.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
      const [pad] = await tx<PadRow[]>`SELECT blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${access.readId}`;
      this.assertActive(pad);
      const [file] = await tx<
        { bytes: Uint8Array<ArrayBuffer>; name: string; type: string }[]
      >`SELECT bytes,name,checked_type AS type FROM pad_files WHERE read_id=${access.readId} AND key=${key}`;
      if (!file) throw new NotesError("not_found", 404);
      return file;
    });
  }
  async humanOpen(readId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const [row] = await tx<PadRow[]>`SELECT blocked_at,deleted_at,status_reason FROM pads WHERE read_id=${readId} FOR UPDATE`;
      this.assertActive(row);
      await tx`UPDATE pads SET last_human_open_on=CURRENT_DATE WHERE read_id=${readId} AND last_human_open_on<>CURRENT_DATE`;
    });
  }
  async mark(readId: string, kind: "delete" | "block" | "expire", reason: string, today?: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const rows =
        kind === "expire"
          ? await tx`UPDATE pads SET deleted_at=now(),status_reason='expired' WHERE read_id=${readId} AND deleted_at IS NULL AND blocked_at IS NULL AND last_human_open_on<=(${today}::date-interval '6 months') RETURNING read_id`
          : await tx`UPDATE pads SET blocked_at=CASE WHEN ${kind}='block' THEN now() ELSE blocked_at END,deleted_at=CASE WHEN ${kind}='delete' THEN now() ELSE deleted_at END,status_reason=COALESCE(status_reason,${reason}) WHERE read_id=${readId} AND deleted_at IS NULL AND blocked_at IS NULL RETURNING read_id`;
      return rows.length === 1;
    });
  }
  async cleanup(readId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const [pad] = await tx<PadRow[]>`SELECT size_bytes::text,blocked_at,deleted_at FROM pads WHERE read_id=${readId} FOR UPDATE`;
      if (!pad || (!pad.blocked_at && !pad.deleted_at)) throw new NotesError("invalid_cleanup");
      await this.reserve(tx, -Number(pad.size_bytes) + costs.pad);
      await tx`DELETE FROM pad_updates WHERE read_id=${readId}`;
      await tx`DELETE FROM pad_files WHERE read_id=${readId}`;
      await tx`DELETE FROM pad_previews WHERE read_id=${readId}`;
      await tx`UPDATE pads SET snapshot=''::bytea,content_md='',size_bytes=${costs.pad} WHERE read_id=${readId}`;
    });
  }
  async pendingCleanup(batch: number): Promise<string[]> {
    const rows = await this.db<
      { read_id: string }[]
    >`SELECT read_id FROM pads WHERE (deleted_at IS NOT NULL OR blocked_at IS NOT NULL) AND (size_bytes<>${costs.pad} OR octet_length(snapshot)>0) ORDER BY read_id LIMIT ${batch}`;
    return rows.map((row) => row.read_id);
  }
  async expired(today: string, batch: number): Promise<string[]> {
    const rows = await this.db<
      { read_id: string }[]
    >`SELECT read_id FROM pads WHERE deleted_at IS NULL AND blocked_at IS NULL AND last_human_open_on<=(${today}::date-interval '6 months') ORDER BY last_human_open_on LIMIT ${batch}`;
    return rows.map((row) => row.read_id);
  }
}
