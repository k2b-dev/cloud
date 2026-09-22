import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import type { DocumentArtifact } from "../contracts";
import type { WorkflowDocumentDataCapture } from "../workflows/query-contracts";
import { loadDocumentArtifacts } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { capturedDocumentRecords } from "./document-record-sources";
import {
  DOCUMENT_ZIP_MAX_BYTES,
  DOCUMENT_ZIP_MAX_ENTRIES,
  DocumentZipBoundError,
  DocumentZipWriter,
  zipEndRecordBytes,
  zipEntryOverheadBytes,
  zipMethodForMediaType,
} from "./document-zip-archive";

const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const artifactKeyPattern = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Authoring shape of `output: { kind: zip }`. `template` and `include` hold
 * workflow references while authoring; the workflow action substitutes the
 * bound template IDs and the resolved Document IDs before issuance freezes
 * the request.
 */
export const DocumentZipOutputSchema = z
  .object({
    kind: z.literal("zip"),
    files: z
      .array(
        z
          .object({
            column: z.string().trim().min(1).max(200).optional(),
            template: z.string().trim().min(1).max(200).optional(),
            mediaType: z.string().max(255).regex(mediaTypePattern).optional(),
            required: z.boolean().default(true),
            folder: z
              .string()
              .trim()
              .min(1)
              .max(64)
              .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
              .refine((value) => value !== "." && value !== "..")
              .optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    include: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict()
  .refine((value) => value.files.length + value.include.length > 0, "ZIP output needs files or include");

export type DocumentZipOutput = z.infer<typeof DocumentZipOutputSchema>;

/** Frozen with the issuance receipt: what the archive contains, in order. */
export const DocumentZipManifestSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            d: z.uuid(),
            s: z.string().min(1),
            k: z.string().regex(artifactKeyPattern),
            p: z.string().min(1).max(512),
            b: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(DOCUMENT_ZIP_MAX_ENTRIES),
    tableIds: z.array(z.uuid()),
    sourceBytes: z.number().int().nonnegative(),
  })
  .strict();

export type DocumentZipManifest = z.infer<typeof DocumentZipManifestSchema>;

type CandidateDocument = { id: string; shortId: string; tableId: string | null; artifacts: DocumentArtifact[] };
type Candidate = { document: CandidateDocument; artifact: DocumentArtifact; folder: string | undefined };

const relationIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : typeof value === "string" && value.length > 0
      ? [value]
      : [];

const splitFilename = (filename: string): { stem: string; extension: string } => {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? { stem: filename.slice(0, dot), extension: filename.slice(dot) } : { stem: filename, extension: "" };
};

/**
 * Deterministic entry order and names. Later duplicates of one Document
 * artifact are dropped; equal file names get the Document ID (and artifact
 * key) appended so nothing is overwritten inside the archive.
 */
export const planZipEntries = (candidates: readonly Candidate[]): DocumentZipManifest["entries"] => {
  const seen = new Set<string>();
  const used = new Set<string>();
  const entries: DocumentZipManifest["entries"] = [];
  for (const { document, artifact, folder } of candidates) {
    const identity = `${document.id}:${artifact.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { stem, extension } = splitFilename(artifact.filename);
    const prefix = folder ? `${folder}/` : "";
    const names = [
      `${prefix}${artifact.filename}`,
      `${prefix}${stem} (${document.shortId})${extension}`,
      `${prefix}${stem} (${document.shortId}-${artifact.key})${extension}`,
    ];
    const path = names.find((name) => !used.has(name));
    if (!path) throw new Error(`Archive path collision for ${identity}`);
    used.add(path);
    entries.push({ d: document.id, s: document.shortId, k: artifact.key, p: path, b: artifact.sizeBytes });
  }
  return entries;
};

const loadDocumentsForRecords = async (
  input: { baseId: string; recordIds: readonly string[]; templateId: string | undefined },
  client: SQL,
): Promise<Map<string, CandidateDocument[]>> => {
  if (input.recordIds.length === 0) return new Map();
  const rows = await client<Array<{ id: string; short_id: string; table_id: string; record_id: string }>>`
    SELECT d.id::text, d.short_id, d.table_id::text, d.record_id::text
    FROM grids.documents d
    WHERE d.base_id = ${input.baseId}::uuid
      AND d.record_id = ANY(${client.array([...input.recordIds], "UUID")}::uuid[])
      ${input.templateId === undefined ? client`` : client`AND d.template_id = ${input.templateId}::uuid`}
    ORDER BY d.created_at, d.id
  `;
  const artifacts = await loadDocumentArtifacts(
    rows.map((row) => row.id),
    client,
  );
  const byRecord = new Map<string, CandidateDocument[]>();
  for (const row of rows) {
    const list = byRecord.get(row.record_id) ?? [];
    list.push({ id: row.id, shortId: row.short_id, tableId: row.table_id, artifacts: artifacts.get(row.id) ?? [] });
    byRecord.set(row.record_id, list);
  }
  return byRecord;
};

/**
 * Resolves the file selection against the captured data and the current
 * Documents of this Base. Runs once, at reservation, so retries rebuild the
 * exact same archive even after new Documents are issued.
 */
export const resolveDocumentZipManifest = async (
  input: { baseId: string; payload: WorkflowDocumentDataCapture["payload"]; output: DocumentZipOutput; locale?: string },
  client: SQL,
): Promise<Result<DocumentZipManifest>> => {
  const t = documentServiceText(input.locale);
  const candidates: Candidate[] = [];
  const tableIds = new Set<string>();
  for (const selection of input.output.files) {
    let recordShortIds: string[];
    if (selection.column === undefined) {
      const records = capturedDocumentRecords(input.payload);
      if (records === null) return fail(err.badInput(t.zipRowsNotRowQuery));
      recordShortIds = records.map((record) => record.recordId);
    } else {
      const column = input.payload.columns.find((candidate) => candidate.label === selection.column);
      if (!column) return fail(err.badInput(t.zipColumnUnknown({ column: selection.column })));
      if (column.type !== "relation") return fail(err.badInput(t.zipColumnNotRelation({ column: selection.column })));
      recordShortIds = [];
      for (const [index, row] of input.payload.rows.entries()) {
        const ids = relationIds(row[column.key]);
        if (ids.length === 0 && selection.required)
          return fail(err.badInput(t.zipRelationMissing({ column: selection.column, row: index + 1 })));
        recordShortIds.push(...ids);
      }
    }
    const uniqueShortIds = [...new Set(recordShortIds)];
    if (uniqueShortIds.length === 0) continue;
    const records = await client<Array<{ id: string; short_id: string; table_id: string }>>`
      SELECT r.id::text, r.short_id, r.table_id::text
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id
      WHERE t.base_id = ${input.baseId}::uuid AND r.short_id = ANY(${client.array(uniqueShortIds, "TEXT")}::text[])
    `;
    const byShortId = new Map(records.map((record) => [record.short_id, record]));
    for (const shortId of uniqueShortIds) {
      if (!byShortId.has(shortId)) return fail(err.badInput(t.zipRecordUnavailable({ record: shortId })));
    }
    let templateId: string | undefined;
    if (selection.template !== undefined) {
      const [template] = await client<Array<{ id: string }>>`
        SELECT dt.id::text FROM grids.document_templates dt
        JOIN grids.tables t ON t.id = dt.table_id
        WHERE t.base_id = ${input.baseId}::uuid AND dt.id::text = ${selection.template} AND dt.deleted_at IS NULL
      `;
      if (!template) return fail(err.badInput(t.zipTemplateUnknown({ template: selection.template })));
      templateId = template.id;
    }
    const documents = await loadDocumentsForRecords(
      { baseId: input.baseId, recordIds: records.map((record) => record.id), templateId },
      client,
    );
    for (const shortId of uniqueShortIds) {
      const record = byShortId.get(shortId);
      if (!record) continue;
      let matched = 0;
      for (const document of documents.get(record.id) ?? []) {
        for (const artifact of document.artifacts) {
          if (selection.mediaType !== undefined && artifact.mimeType.toLowerCase() !== selection.mediaType.toLowerCase()) continue;
          candidates.push({ document, artifact, folder: selection.folder });
          if (document.tableId) tableIds.add(document.tableId);
          matched += 1;
        }
      }
      if (matched === 0 && selection.required) return fail(err.badInput(t.zipRecordFilesMissing({ record: shortId })));
    }
  }
  if (input.output.include.length > 0) {
    const ids = [...new Set(input.output.include)];
    if (ids.some((id) => !z.uuid().safeParse(id).success)) return fail(err.badInput(t.zipIncludeUnavailable({ document: ids.join(", ") })));
    const rows = await client<Array<{ id: string; short_id: string; table_id: string | null }>>`
      SELECT d.id::text, d.short_id, d.table_id::text FROM grids.documents d
      WHERE d.base_id = ${input.baseId}::uuid AND d.id = ANY(${client.array(ids, "UUID")}::uuid[])
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const artifacts = await loadDocumentArtifacts(ids, client);
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) return fail(err.badInput(t.zipIncludeUnavailable({ document: id })));
      const document = { id: row.id, shortId: row.short_id, tableId: row.table_id, artifacts: artifacts.get(id) ?? [] };
      for (const artifact of document.artifacts) candidates.push({ document, artifact, folder: undefined });
      if (row.table_id) tableIds.add(row.table_id);
    }
  }
  if (candidates.length === 0) return fail(err.badInput(t.zipEmpty));
  const entries = planZipEntries(candidates);
  if (entries.length > DOCUMENT_ZIP_MAX_ENTRIES) return fail(err.badInput(t.zipTooManyFiles({ limit: DOCUMENT_ZIP_MAX_ENTRIES })));
  let sourceBytes = 0;
  let archiveBound = zipEndRecordBytes;
  for (const entry of entries) {
    sourceBytes += entry.b;
    archiveBound += entry.b + zipEntryOverheadBytes(entry.p);
  }
  if (archiveBound > DOCUMENT_ZIP_MAX_BYTES) return fail(err.badInput(t.zipTooLarge({ limit: DOCUMENT_ZIP_MAX_BYTES })));
  return ok({ entries, tableIds: [...tableIds].sort(), sourceBytes });
};

/** Heartbeat cadence: measured ~1.2 ms per source read plus ~80 MiB/s staging, so either bound keeps beats well under a second apart. */
const HEARTBEAT_ENTRIES = 32;
const HEARTBEAT_BYTES = 16 * 1024 * 1024;

export type DocumentZipProvenance = { entries: { document: string; key: string; path: string; sizeBytes: number }[] };

/** What the archive contains, stored as the Document's profile output. */
export const documentZipProvenance = (manifest: DocumentZipManifest): DocumentZipProvenance => ({
  entries: manifest.entries.map((entry) => ({ document: entry.s, key: entry.k, path: entry.p, sizeBytes: entry.b })),
});

/**
 * Streams the frozen manifest into a ZIP through `sink`, inside the caller's
 * transaction. Every source is verified against its stored size and SHA-256
 * before it enters the archive; the writer records a CRC per entry.
 */
export const writeDocumentZip = async (
  input: { manifest: DocumentZipManifest; modifiedAt: Date; heartbeat?: () => Promise<void>; locale?: string },
  client: SQL,
  sink: (bytes: Uint8Array) => Promise<void>,
): Promise<{ sizeBytes: number }> => {
  const t = documentServiceText(input.locale);
  const writer = new DocumentZipWriter(input.modifiedAt, sink);
  let sinceHeartbeat = { entries: 0, bytes: 0 };
  try {
    for (const entry of input.manifest.entries) {
      const [row] = await client<Array<{ mime_type: string; size_bytes: number | string; sha256: string; bytes: Uint8Array }>>`
        SELECT file.mime_type, file.size_bytes, file.sha256, file.bytes
        FROM grids.document_artifacts artifact
        JOIN grids.files file ON file.id = artifact.file_id
        JOIN grids.file_protected_references protected
          ON protected.file_id = file.id AND protected.owner_kind = 'document_artifact' AND protected.owner_id = artifact.document_id
        WHERE artifact.document_id = ${entry.d}::uuid AND artifact.artifact_key = ${entry.k}
      `;
      if (!row) throw err.badInput(t.zipIncludeUnavailable({ document: entry.s }));
      const sizeBytes = Number(row.size_bytes);
      if (
        sizeBytes !== entry.b ||
        row.bytes.byteLength !== sizeBytes ||
        createHash("sha256").update(row.bytes).digest("hex") !== row.sha256
      ) {
        throw err.internal(t.zipSourceIntegrityFailed({ path: entry.p }));
      }
      await writer.add(entry.p, row.bytes, zipMethodForMediaType(row.mime_type));
      sinceHeartbeat = { entries: sinceHeartbeat.entries + 1, bytes: sinceHeartbeat.bytes + sizeBytes };
      if (input.heartbeat && (sinceHeartbeat.entries >= HEARTBEAT_ENTRIES || sinceHeartbeat.bytes >= HEARTBEAT_BYTES)) {
        await input.heartbeat();
        sinceHeartbeat = { entries: 0, bytes: 0 };
      }
    }
    return await writer.finish();
  } catch (error) {
    if (error instanceof DocumentZipBoundError) {
      throw err.badInput(error.bound === "bytes" ? t.zipTooLarge({ limit: error.limit }) : t.zipTooManyFiles({ limit: error.limit }));
    }
    throw error;
  }
};
