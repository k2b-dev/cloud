import type {
  DocumentProfile,
  Field,
  FieldColumnSpec,
  GridRecord,
  RecordAuditContext,
  RecordDisplayConfig,
  TableAuditPolicy,
  TableKind,
} from "../contracts";

export type { Base, Field, GridRecord, Table } from "../contracts";

/**
 * Wrapper shape returned by `record.list` — bundles the rows, the
 * source table's schema (once, not duplicated per record), and the
 * cursor for the next page in a single response. Designed so that
 * presentational components like `<DatabaseTable>` take a single
 * prop and have everything they need to render — no separate
 * fetch-and-pass-as-two-props ceremony.
 *
 * `fields` is included unconditionally. The list resolver fetches
 * the table's fields internally anyway (for filter compilation and
 * relation hydration); echoing them on the way out costs nothing
 * and saves callers a second `field.listByTable` roundtrip.
 *
 * Pagination is cursor-based — `nextCursor` is the opaque token to
 * pass back as `params.cursor` on the next call, or `null` when the
 * current page is the last. We deliberately don't carry a `total`
 * here because counting rows on filtered queries is a separate
 * (expensive) query and most consumers don't actually need it.
 */
export type RecordList = {
  items: GridRecord[];
  fields: Field[];
  nextCursor: string | null;
  filePreviews?: Record<string, Record<string, GridFilePreview>>;
  /** SQL-computed footer-style aggregates over the full filtered result
   *  set, not just the current page. Keys follow `<fieldId>__<agg>` plus
   *  `*__count` for the filtered row count. */
  aggregates?: Record<string, unknown>;
};

export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "restored"
  | "finalized"
  | "imported"
  | "file.added"
  | "file.replaced"
  | "file.removed"
  | "durable_history.enabled"
  | "finalization.enabled"
  | "finalization.disabled"
  | "finalization.policy.updated"
  | "finalization.requested"
  | "finalization.request.approved"
  | "finalization.request.rejected"
  | "mutation_policy.updated"
  | "retention_policy.updated"
  | "retention_policy.removed"
  | "preservation_hold.created"
  | "preservation_hold.released"
  | "controlled_destruction.started"
  | "controlled_destruction.file_destroyed"
  | "access.granted"
  | "access.updated"
  | "access.revoked"
  | "workflow.created"
  | "workflow.updated"
  | "workflow.revision.restored"
  | "workflow.deleted"
  | "workflow.access.granted"
  | "workflow.access.updated"
  | "workflow.access.revoked"
  | "workflow.run.started"
  | "workflow.run.recovered"
  | "workflow.run.succeeded"
  | "workflow.run.failed"
  | "workflow.run.canceled"
  | "workflow.run.needs_attention"
  | "workflow.record.updated"
  | "workflow.record.created"
  | "workflow.record.finalized"
  | "workflow.record.finalization.requested"
  | "workflow.document.generated"
  | "workflow.document_link.created"
  | "workflow.email.sent"
  | "workflow.email.queued"
  | "workflow.email.failed"
  | "workflow.http.sent"
  | "workflow.http.failed"
  | "email_template.created"
  | "email_template.updated"
  | "email_template.deleted"
  | "document_template.created"
  | "document.generated"
  | "document.metadata.updated"
  | "business_document.issued"
  | "record_snapshot.created"
  | "document_link.created"
  | "document_link.revoked"
  | "document_link.accessed"
  | "federation.draft.updated"
  | "federation.published"
  | "federation.source.revoked"
  | "federation.revalidating"
  | "federation.degraded"
  | "federation.repaired";

export type AuditEntry = {
  id: string;
  baseId: string | null;
  tableId: string | null;
  recordId: string | null;
  userId: string | null;
  /** Persisted audit actions are additive; readers must tolerate actions from newer or older producers. */
  action: string;
  diff: Record<string, { old: unknown; new: unknown }> | null;
  context: RecordAuditContext | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type GridFile = {
  id: string;
  shortId: string;
  recordId: string;
  fieldId: string;
  position: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdBy: string | null;
  createdAt: string;
};

export type GridFilePreview = {
  fileId: string;
  recordId: string;
  fieldId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type GridFileContent = GridFile & {
  bytes: Uint8Array;
};

export type CreateBaseInput = { name: string; description?: string | null };
export type UpdateBaseInput = {
  name?: string;
  description?: string | null;
  documentProfile?: DocumentProfile;
};

export type CreateTableInput = {
  baseId: string;
  kind?: TableKind;
  name: string;
  description?: string | null;
  icon?: string | null;
  columns?: FieldColumnSpec[];
  displayConfig?: RecordDisplayConfig;
};
export type UpdateTableInput = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  columns?: FieldColumnSpec[];
  displayConfig?: RecordDisplayConfig;
  auditPolicy?: TableAuditPolicy;
  disableDirectInsert?: boolean;
};

export type CreateFieldInput = {
  tableId: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  type: string;
  config?: Record<string, unknown>;
  position?: number;
  required?: boolean;
  presentable?: boolean;
  hideInTable?: boolean;
  defaultValue?: unknown;
  indexed?: boolean;
  uniqueConstraint?: boolean;
};

export type UpdateFieldInput = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  config?: Record<string, unknown>;
  position?: number;
  required?: boolean;
  presentable?: boolean;
  hideInTable?: boolean;
  defaultValue?: unknown;
  indexed?: boolean;
  uniqueConstraint?: boolean;
};
