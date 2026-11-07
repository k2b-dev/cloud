import * as Y from "yjs";
import type { NoteRecord } from "../model";

export type StoredFile = { noteId: string; key: string; name: string; blob: Blob };
export type Snapshot = { records: NoteRecord[]; updates: { noteId: string; update: Uint8Array }[]; files: StoredFile[] };
export type Write =
  | { kind: "record"; record: NoteRecord }
  | { kind: "patch"; id: string; patch: Partial<Omit<NoteRecord, "id">> }
  | { kind: "update"; noteId: string; update: Uint8Array }
  | { kind: "file"; file: StoredFile }
  | { kind: "removeFile"; noteId: string; key: string }
  | { kind: "remove"; id: string }
  | { kind: "clear" };

/** A write batch is atomic. compact reads and replaces updates in one transaction. */
export interface Backend {
  load(): Promise<Snapshot>;
  write(writes: readonly Write[]): Promise<void>;
  compact(id: string): Promise<void>;
  close(): void;
}
export function mergedUpdate(updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, update);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

export class MemoryBackend implements Backend {
  private state: Snapshot = { records: [], updates: [], files: [] };
  async load(): Promise<Snapshot> {
    return structuredClone(this.state);
  }
  async write(writes: readonly Write[]): Promise<void> {
    const next = structuredClone(this.state);
    for (const write of writes) {
      if (write.kind === "clear") {
        next.records = [];
        next.updates = [];
        next.files = [];
      }
      if (write.kind === "record") {
        next.records = next.records.filter((record) => record.id !== write.record.id);
        next.records.push(structuredClone(write.record));
      }
      if (write.kind === "patch") {
        const record = next.records.find((record) => record.id === write.id);
        if (record) Object.assign(record, structuredClone(write.patch));
      }
      if (write.kind === "update" && next.records.some((record) => record.id === write.noteId))
        next.updates.push({ noteId: write.noteId, update: write.update.slice() });
      if (write.kind === "file" && next.records.some((record) => record.id === write.file.noteId)) {
        next.files = next.files.filter((file) => file.noteId !== write.file.noteId || file.key !== write.file.key);
        next.files.push(write.file);
      }
      if (write.kind === "removeFile") next.files = next.files.filter((file) => file.noteId !== write.noteId || file.key !== write.key);
      if (write.kind === "remove") {
        next.records = next.records.filter((record) => record.id !== write.id);
        next.updates = next.updates.filter((update) => update.noteId !== write.id);
        next.files = next.files.filter((file) => file.noteId !== write.id);
      }
    }
    this.state = next;
  }
  async compact(id: string): Promise<void> {
    const updates = this.state.updates.filter((update) => update.noteId === id).map((item) => item.update);
    if (!updates.length || !this.state.records.some((record) => record.id === id)) return;
    const update = mergedUpdate(updates);
    this.state.updates = [...this.state.updates.filter((update) => update.noteId !== id), { noteId: id, update }];
  }
  close(): void {}
}
