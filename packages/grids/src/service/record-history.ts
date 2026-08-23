import * as storedAudit from "./audit";
import * as combinedAudit from "./combined-audit";
import { get as getTable } from "./tables";
import type { AuditAction } from "./types";

// This exhaustive map is the single admission boundary between the additive
// audit namespace and Record history. Adding an AuditAction requires an
// explicit decision here; persisted actions from a newer producer remain
// readable as one redacted unknown event.
const AUDIT_ACTION_VISIBILITY = {
  "document.created": "record",
  created: "record",
  updated: "record",
  deleted: "record",
  restored: "record",
  finalized: "record",
  imported: "record",
  "file.added": "record",
  "file.replaced": "record",
  "file.removed": "record",
  "finalization.requested": "record",
  "finalization.request.approved": "record",
  "finalization.request.rejected": "record",
  "workflow.record.updated": "record",
  "workflow.record.created": "record",
  "workflow.record.finalized": "record",
  "workflow.record.finalization.requested": "record",
  "workflow.document_link.created": "record",
  "record_snapshot.created": "record",
  "document_link.created": "record",
  "document_link.revoked": "record",
  "document_link.accessed": "operational",
  "durable_history.enabled": "operational",
  "finalization.enabled": "operational",
  "finalization.disabled": "operational",
  "finalization.policy.updated": "operational",
  "mutation_policy.updated": "operational",
  "retention_policy.updated": "operational",
  "retention_policy.removed": "operational",
  "preservation_hold.created": "operational",
  "preservation_hold.released": "operational",
  "controlled_destruction.started": "operational",
  "controlled_destruction.file_destroyed": "operational",
  "access.granted": "operational",
  "access.updated": "operational",
  "access.revoked": "operational",
  "workflow.created": "operational",
  "workflow.updated": "operational",
  "workflow.revision.restored": "operational",
  "workflow.deleted": "operational",
  "workflow.access.granted": "operational",
  "workflow.access.updated": "operational",
  "workflow.access.revoked": "operational",
  "workflow.run.started": "operational",
  "workflow.run.recovered": "operational",
  "workflow.run.succeeded": "operational",
  "workflow.run.failed": "operational",
  "workflow.run.canceled": "operational",
  "workflow.run.needs_attention": "operational",
  "workflow.email.sent": "operational",
  "workflow.email.queued": "operational",
  "workflow.email.failed": "operational",
  "workflow.http.sent": "operational",
  "workflow.http.failed": "operational",
  "email_template.created": "operational",
  "email_template.updated": "operational",
  "email_template.deleted": "operational",
  "document_template.created": "operational",
  "federation.draft.updated": "operational",
  "federation.published": "operational",
  "federation.source.revoked": "operational",
  "federation.revalidating": "operational",
  "federation.degraded": "operational",
  "federation.repaired": "operational",
} as const satisfies Record<AuditAction, "record" | "operational">;

type KnownRecordHistoryAction = {
  [Action in AuditAction]: (typeof AUDIT_ACTION_VISIBILITY)[Action] extends "record" ? Action : never;
}[AuditAction];

export type RecordHistoryAction = KnownRecordHistoryAction | "unknown";

export const isRecordHistoryAction = (action: string): action is RecordHistoryAction =>
  action === "unknown" || AUDIT_ACTION_VISIBILITY[action as AuditAction] === "record";

const NON_RECORD_HISTORY_ACTIONS = Object.entries(AUDIT_ACTION_VISIBILITY).flatMap(([action, visibility]) =>
  visibility === "operational" ? [action as AuditAction] : [],
);

type RawRecordHistoryEntry =
  | Awaited<ReturnType<typeof storedAudit.listByRecord>>[number]
  | Awaited<ReturnType<typeof combinedAudit.listByRecord>>[number];

type WithRecordHistoryAction<Entry> = Entry extends unknown ? Omit<Entry, "action"> & { action: RecordHistoryAction } : never;

export type RecordHistoryEntry = WithRecordHistoryAction<RawRecordHistoryEntry>;

export const projectRecordHistoryEntry = (entry: RawRecordHistoryEntry): RecordHistoryEntry | null => {
  const visibility = AUDIT_ACTION_VISIBILITY[entry.action as AuditAction];
  if (visibility === "operational") return null;
  if (visibility === "record") return { ...entry, action: entry.action as KnownRecordHistoryAction };
  return { ...entry, action: "unknown", diff: null, context: null };
};

export const listByRecord = async (
  tableId: string,
  recordId: string,
  limit = 50,
  fieldIds?: readonly string[],
): Promise<RecordHistoryEntry[]> => {
  const table = await getTable(tableId);
  if (!table) return [];
  const entries =
    table.kind === "federated"
      ? combinedAudit.listByRecord(tableId, recordId, limit, fieldIds)
      : storedAudit.listByRecord(tableId, recordId, limit, NON_RECORD_HISTORY_ACTIONS);
  return (await entries).flatMap((entry) => {
    const projected = projectRecordHistoryEntry(entry);
    return projected ? [projected] : [];
  });
};
