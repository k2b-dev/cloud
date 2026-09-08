import type { PublicRecordRevisionPage } from "../api/durable-history";
import type { PublicGridRecord as GridRecord, PublicGridFile } from "../api/public-dto";
import type { CombinedAuditPage } from "../service";
import { displayValue } from "./views-gql-support";

export type RecordAuditResponse = { items: unknown[] };
export type CombinedAuditResponse = CombinedAuditPage;
export type GridFile = PublicGridFile;
export type RecordRevisionPage = PublicRecordRevisionPage;

type PublicRecordSnapshotSummary = {
  id: string;
  recordId: string;
  tableId: string;
  createdBy: string | null;
  createdAt: string;
};

export type GridFileListResponse = { items: GridFile[] };
export type RecordSnapshotListResponse = { items: PublicRecordSnapshotSummary[] };
export type PublicRecordSnapshot = PublicRecordSnapshotSummary & {
  baseId: string;
  root: Record<string, unknown>;
  graph: Record<string, unknown>;
};
export type CreateRecordSnapshotResponse = { snapshot: PublicRecordSnapshot; created: boolean };

export const gridFileRows = (items: GridFile[]) =>
  items.map((file) => ({
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    position: file.position,
    createdAt: file.createdAt,
  }));

export const snapshotRows = (items: RecordSnapshotListResponse["items"]) =>
  items.map((snapshot) => ({
    id: snapshot.id,
    recordId: snapshot.recordId,
    tableId: snapshot.tableId,
    createdBy: snapshot.createdBy ?? "",
    createdAt: snapshot.createdAt,
  }));

export const recordRows = (items: GridRecord[]) =>
  items.map((record) => ({
    id: record.id,
    version: record.version,
    updatedAt: record.updatedAt,
    ...Object.fromEntries(Object.entries(record.data).map(([key, value]) => [key, displayValue(value)])),
  }));

export const recordRevisionRows = (items: RecordRevisionPage["items"]) =>
  items.map((revision) => ({
    id: revision.id,
    revision: revision.revision,
    action: revision.action,
    recordVersion: revision.recordVersion,
    changedFields: revision.changedFieldIds.length,
    files: revision.files.length,
    actor: revision.actorDisplayName ?? "",
    createdAt: revision.createdAt,
  }));

export const combinedAuditRows = (items: CombinedAuditPage["items"]) =>
  items.map((entry) => ({
    createdAt: entry.createdAt,
    action: entry.action,
    recordId: entry.recordId ?? "",
    source: `${entry.source.baseName} / ${entry.source.tableName}`,
    actor: entry.userDisplayName ?? (entry.userId ? "deleted user" : "public form"),
    answers: entry.context?.answers.map((answer) => `${answer.label}: ${answer.optionLabel ?? answer.value}`).join("; ") ?? "",
    changes: entry.diff ? Object.keys(entry.diff).length : 0,
    deleted: entry.recordDeletedAt ? "yes" : "",
  }));

export const normalizeRecordImportBody = (input: unknown): { items: Record<string, unknown>[] } => {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? (input as { items: unknown[] }).items
      : null;
  if (!items) throw new Error("Record import JSON must be an array or an object with an items array.");
  if (items.length === 0) throw new Error("Record import JSON must contain at least one item.");
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each imported record must be a JSON object keyed by field public id.");
    }
  }
  return { items: items as Record<string, unknown>[] };
};
