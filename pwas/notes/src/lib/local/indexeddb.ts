import type { NoteRecord } from "../model";
import { type Backend, mergedUpdate, type Snapshot, type StoredFile, type Write } from "./backend";

type UpdateRow = { seq?: number; noteId: string; update: Uint8Array };
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}
export async function openIndexedDB(name = "k2b-notes"): Promise<Backend> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("records", { keyPath: "id" });
    db.createObjectStore("updates", { keyPath: "seq", autoIncrement: true }).createIndex("noteId", "noteId");
    db.createObjectStore("files", { keyPath: ["noteId", "key"] }).createIndex("noteId", "noteId");
  };
  let blocked = false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => {
      if (blocked) opening.result.close();
      else resolve(opening.result);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => {
      blocked = true;
      reject(new Error("IndexedDB blocked"));
    };
  });
  db.onversionchange = () => db.close();
  const stores = ["records", "updates", "files"];
  return {
    async load(): Promise<Snapshot> {
      const tx = db.transaction(stores, "readonly");
      const completion = done(tx);
      try {
        const [records, updates, files] = await Promise.all([
          request<NoteRecord[]>(tx.objectStore("records").getAll()),
          request<UpdateRow[]>(tx.objectStore("updates").getAll()),
          request<StoredFile[]>(tx.objectStore("files").getAll()),
        ]);
        await completion;
        return { records, updates, files };
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
    },
    async write(writes: readonly Write[]): Promise<void> {
      const tx = db.transaction(stores, "readwrite");
      const completion = done(tx);
      try {
        for (const write of writes) {
          if (write.kind === "clear") for (const name of stores) await request(tx.objectStore(name).clear());
          if (write.kind === "record") await request(tx.objectStore("records").put(write.record));
          if (write.kind === "patch") {
            const records = tx.objectStore("records");
            const record = await request<NoteRecord | undefined>(records.get(write.id));
            if (record) await request(records.put({ ...record, ...write.patch }));
          }
          if (write.kind === "update" && (await request(tx.objectStore("records").count(write.noteId))))
            await request(tx.objectStore("updates").add({ noteId: write.noteId, update: write.update }));
          if (write.kind === "file" && (await request(tx.objectStore("records").count(write.file.noteId))))
            await request(tx.objectStore("files").put(write.file));
          if (write.kind === "removeFile") await request(tx.objectStore("files").delete([write.noteId, write.key]));
          if (write.kind === "remove") {
            await request(tx.objectStore("records").delete(write.id));
            for (const name of ["updates", "files"]) {
              const store = tx.objectStore(name);
              const keys = await request(store.index("noteId").getAllKeys(write.id));
              for (const key of keys) await request(store.delete(key));
            }
          }
        }
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* The transaction may already have aborted. */
        }
        await completion.catch(() => undefined);
        throw error;
      }
      await completion;
    },
    async compact(id: string): Promise<void> {
      const tx = db.transaction("updates", "readwrite");
      const completion = done(tx);
      const store = tx.objectStore("updates");
      const read: IDBRequest<UpdateRow[]> = store.index("noteId").getAll(id);
      read.onsuccess = () => {
        const rows = read.result;
        if (!rows.length) return;
        const update = mergedUpdate(rows.map((row) => row.update));
        for (const row of rows) if (row.seq !== undefined) store.delete(row.seq);
        store.add({ noteId: id, update });
      };
      await completion;
    },
    close() {
      db.close();
    },
  };
}
