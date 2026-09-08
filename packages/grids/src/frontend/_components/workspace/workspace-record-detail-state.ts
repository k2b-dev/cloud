import type { DocumentTemplateSummary } from "../../../contracts";
import type { Field, GridRecord } from "../../../service";
import { gridsService } from "../../../service";
import type { ExpansionViewer } from "../../../service/relation-access";
import type { WorkspaceCommon, WorkspaceRecordDetail } from "./workspace-state-model";

const DETAIL_PAGE_SIZE = 100;

export const writableDocumentTemplates = (common: WorkspaceCommon, tableId: string): DocumentTemplateSummary[] =>
  (common.catalog.documentTemplatesByTable[tableId] ?? []).filter(
    (template) =>
      template.enabled && gridsService.permission.hasAtLeast(common.catalog.documentTemplateLevels[template.id] ?? "none", "write"),
  );

export const loadRecordDetailData = async (params: {
  tableId: string;
  recordId: string;
  record: GridRecord;
  fields: Field[];
  viewer: ExpansionViewer;
  scope?: "full" | "history";
  locale?: string;
}): Promise<WorkspaceRecordDetail> => {
  const fileFieldIds = params.fields.filter((field) => field.type === "file" && !field.deletedAt).map((field) => field.id);
  const table = await gridsService.table.get(params.tableId);
  if (!table) throw new Error("Table not found");
  const [relationLabels, filesByField, documents, snapshots, auditEntries, combinedOrigin] = await Promise.all([
    params.scope === "history" ? {} : gridsService.relations.buildLabelCache([params.record], params.fields, params.viewer),
    params.scope === "history"
      ? {}
      : gridsService.file.listForRecord({ tableId: params.tableId, recordId: params.recordId, fieldIds: fileFieldIds }),
    params.scope === "history"
      ? { items: [], nextCursor: null, hasMore: false }
      : gridsService.document.listForRecord({
          baseId: table.baseId,
          tableId: params.tableId,
          recordId: params.recordId,
          limit: DETAIL_PAGE_SIZE,
        }),
    params.scope === "history" ? [] : gridsService.document.listSnapshotsForRecord(params.tableId, params.recordId, DETAIL_PAGE_SIZE),
    gridsService.audit.listByRecord(
      params.tableId,
      params.recordId,
      50,
      params.scope === "history" ? params.fields.map((field) => field.id) : undefined,
      params.locale,
    ),
    table?.kind === "federated"
      ? gridsService.audit.combined.describeRecord(params.tableId, params.recordId, params.locale).then((result) => {
          if (!result.ok) throw new Error(result.error.message);
          return result.data;
        })
      : null,
  ]);
  return {
    recordId: params.recordId,
    relationLabels,
    filesByField,
    documents,
    snapshots,
    auditEntries,
    combinedOrigin,
  };
};

export const emptyRecordDetail = (recordId: string): WorkspaceRecordDetail => ({
  recordId,
  relationLabels: {},
  filesByField: {},
  documents: { items: [], nextCursor: null, hasMore: false },
  snapshots: [],
  auditEntries: [],
  combinedOrigin: null,
});
