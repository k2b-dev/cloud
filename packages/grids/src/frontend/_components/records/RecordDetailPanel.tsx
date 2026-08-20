import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, DescriptionList, DetailPanel, Dropdown, IconButton, NoticeCard, prompts, Tooltip, toast } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { PublicRecordFinalizationReadiness, PublicRecordFinalizationRequest } from "../../../api/record-finalization";
import type { ColumnSpec, RecordMutationAudit, TableAuditPolicy } from "../../../contracts";
import { recordAuditRequirementFor } from "../../../record-audit-policy";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import { isUserEditable } from "../fields/field-prompt-schema";
import { errorMessage } from "../utils/api-helpers";
import type {
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { openRecordAuditDialog } from "./RecordAuditDialog";
import RecordComments from "./RecordComments.island";
import RecordDocumentsSection from "./RecordDocumentsSection";
import RecordFileField from "./RecordFileField";
import RecordHistorySection from "./RecordHistorySection";
import RecordReadView from "./RecordReadView";
import RecordReferencedBy from "./RecordReferencedBy.island";
import { openRecordUpsertDialog } from "./RecordUpsertDialog";
import RecordVersions from "./RecordVersions.island";
import { CorrectionDraftInvocationError, createCorrectionDraft } from "./record-correction";
import { recordDisplayTitle } from "./record-display";

type Props = {
  cloudUrl: string;
  baseId: string;
  tableId: string;
  tableName: string;
  fields: Field[];
  auditPolicy: TableAuditPolicy;
  /** Currently-displayed record. Controlled by RecordsView — when the
   *  user clicks a different row in the grid, the parent passes a new
   *  record here. null = panel renders nothing. */
  record: () => GridRecord | null;
  detail: () => WorkspaceRecordDetail | null;
  documentTemplates: PublicDocumentTemplateSummary[];
  /** "live" = edit/delete; "trash" = restore. Driven by the URL state's
   *  trash flag, lifted up to the parent. */
  mode: () => "live" | "trash";
  /** True if the user can edit/delete records on this table. */
  canWrite: boolean;
  canRunWorkflows: boolean;
  /** Pre-resolved labels for linked records (target id → display label).
   *  Built SSR-side; used by relation cells to render presentable
   *  values instead of raw UUIDs. */
  relationLabels?: Record<string, string>;
  fieldsByTable?: Record<string, Field[]>;
  viewColumns?: ColumnSpec[];
  dateConfig?: DateContext;
  /** Close the panel (delegates URL writeback to RecordsView). */
  onClose: () => void;
  /** Emitted after a successful edit. RecordsView refetches the data
   *  resource so the grid reflects the new value. */
  onUpdated: (record: GridRecord) => void;
  /** Emitted after a successful delete or restore. RecordsView closes
   *  the panel + refetches. */
  onRemoved: () => void;
  recordActionLaunchers: WorkspaceRecordLauncher[];
  onOpenRecord: (recordId: string) => void;
};

export default function RecordDetailPanel(props: Props) {
  let correctionOperation: { key: string; id: string } | null = null;
  const record = () => props.record();
  const mode = () => props.mode();
  const finalizationQueryEnabled = () => {
    const rec = record();
    return Boolean(rec && props.canWrite && mode() === "live" && !rec.finalizedAt);
  };
  const finalizationQuery = query.create({
    source: record,
    enabled: finalizationQueryEnabled,
    load: async (rec, { abortSignal }) => {
      if (!rec) throw new Error("No Record is selected.");
      const response = await apiClient.records[":tableId"][":recordId"].finalization.$get(
        { param: { tableId: props.tableId, recordId: rec.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not refresh Finalization status"));
      return response.json();
    },
  });
  const finalization = () =>
    !finalizationQueryEnabled() || finalizationQuery.stale() || finalizationQuery.error() ? null : (finalizationQuery.data() ?? null);

  const visibleFields = () => props.fields.filter((f) => !f.deletedAt);
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(value));

  async function refreshFinalization(rec: GridRecord): Promise<PublicRecordFinalizationReadiness> {
    if (record()?.id !== rec.id) throw new Error("The selected Record changed.");
    await finalizationQuery.refresh();
    const refreshError = finalizationQuery.error();
    if (refreshError) throw refreshError;
    const readiness = finalization();
    if (!readiness) throw new Error("Could not refresh Finalization status");
    return readiness;
  }

  const reportFinalizationError = (error: Error) => {
    prompts.error(error.message);
    const rec = record();
    if (!rec) return;
    void refreshFinalization(rec).catch(() =>
      prompts.error("The action failed, and the current Finalization status could not be refreshed."),
    );
  };
  const refreshAfterFinalizationMutation = () => {
    void (async () => {
      await finalizationQuery.refresh();
      if (finalizationQuery.error()) throw finalizationQuery.error();
    })().catch(() => prompts.error("The action succeeded, but the current Finalization status could not be refreshed."));
  };

  // ---- Mutations ---------------------------------------------------------
  const updateMut = mutations.create<GridRecord, { rec: GridRecord; payload: Record<string, unknown>; audit?: RecordMutationAudit }>({
    mutation: async ({ rec, payload, audit }) => {
      const res = await apiClient.records[":tableId"][":recordId"].$patch(
        {
          param: { tableId: props.tableId, recordId: rec.id },
          json: { values: payload, audit },
        },
        { headers: { "If-Match": String(rec.version) } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to update record"));
      return res.json();
    },
    onSuccess: (updated) => props.onUpdated(updated),
    onError: (e) => prompts.error(e.message),
  });

  const deleteMut = mutations.create<string, { rec: GridRecord; audit?: RecordMutationAudit }>({
    mutation: async ({ rec, audit }) => {
      const res = await apiClient.records[":tableId"][":recordId"].trash.$post({
        param: { tableId: props.tableId, recordId: rec.id },
        json: { audit },
      });
      if (res.status >= 400) throw new Error(await errorMessage(res, "Failed to delete record"));
      return rec.id;
    },
    onSuccess: () => props.onRemoved(),
    onError: (e) => prompts.error(e.message),
  });

  const restoreMut = mutations.create<string, { rec: GridRecord; audit?: RecordMutationAudit }>({
    mutation: async ({ rec, audit }) => {
      const res = await apiClient.records[":tableId"][":recordId"].restore.$post({
        param: { tableId: props.tableId, recordId: rec.id },
        json: { audit },
      });
      if (res.status >= 400) throw new Error(await errorMessage(res, "Failed to restore record"));
      return rec.id;
    },
    onSuccess: () => props.onRemoved(),
    onError: (e) => prompts.error(e.message),
  });

  const createCorrectionMut = mutations.create<
    { recordId: string; tableId: string },
    { rec: GridRecord; launcher: WorkspaceRecordLauncher; operationId: string }
  >({
    mutation: async ({ rec, launcher, operationId }, { abortSignal }) => {
      const result = await createCorrectionDraft({
        launcherId: launcher.id,
        expectedRevision: launcher.workflowRevision,
        recordId: rec.id,
        operationId,
        signal: abortSignal,
      });
      if (result.tableId !== props.tableId) throw new Error("The correction workflow returned a Record from another Table.");
      return result;
    },
    onSuccess: (result) => {
      correctionOperation = null;
      props.onOpenRecord(result.recordId);
      toast.success("The linked correction Draft is ready.", { title: "Correction created" });
    },
    onError: (error) => {
      if (error instanceof CorrectionDraftInvocationError && !error.retrySameOperation) correctionOperation = null;
      prompts.error(error.message);
    },
  });

  const finalizeMut = mutations.create<GridRecord, GridRecord>({
    mutation: async (rec) => {
      const res = await apiClient.records[":tableId"][":recordId"].finalize.$post({
        param: { tableId: props.tableId, recordId: rec.id },
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to finalize record"));
      return res.json();
    },
    onSuccess: (updated) => {
      props.onUpdated(updated);
    },
    onError: reportFinalizationError,
  });

  const requestFinalizationMut = mutations.create<
    PublicRecordFinalizationRequest,
    { rec: GridRecord; comment: string | null },
    { rec: GridRecord }
  >({
    onBefore: ({ rec }) => ({ rec }),
    mutation: async ({ rec, comment }) => {
      const response = await apiClient.records[":tableId"][":recordId"].finalization.request.$post({
        param: { tableId: props.tableId, recordId: rec.id },
        json: { comment },
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to request Finalization"));
      return response.json();
    },
    onSuccess: (_request, context) => {
      if (context) props.onUpdated(context.rec);
      refreshAfterFinalizationMutation();
    },
    onError: reportFinalizationError,
  });

  const approveFinalizationMut = mutations.create<GridRecord, { rec: GridRecord; requestId: string; comment: string | null }>({
    mutation: async ({ rec, requestId, comment }) => {
      const response = await apiClient.records[":tableId"][":recordId"].finalization.approve.$post({
        param: { tableId: props.tableId, recordId: rec.id },
        json: { requestId, comment },
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to approve Finalization"));
      return response.json();
    },
    onSuccess: (updated) => {
      props.onUpdated(updated);
    },
    onError: reportFinalizationError,
  });

  const rejectFinalizationMut = mutations.create<
    PublicRecordFinalizationRequest,
    { rec: GridRecord; requestId: string; comment: string | null },
    { rec: GridRecord }
  >({
    onBefore: ({ rec }) => ({ rec }),
    mutation: async ({ rec, requestId, comment }) => {
      const response = await apiClient.records[":tableId"][":recordId"].finalization.reject.$post({
        param: { tableId: props.tableId, recordId: rec.id },
        json: { requestId, comment },
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Failed to reject Finalization"));
      return response.json();
    },
    onSuccess: (_request, context) => {
      if (context) props.onUpdated(context.rec);
      refreshAfterFinalizationMutation();
    },
    onError: reportFinalizationError,
  });

  const resolutionLoading = () =>
    approveFinalizationMut.loading() ||
    rejectFinalizationMut.loading() ||
    finalizationQuery.refreshing() ||
    finalizationQuery.stale() ||
    Boolean(finalizationQuery.error());

  // ---- Handlers ----------------------------------------------------------
  const handleEdit = async (rec: GridRecord) => {
    const usable = visibleFields().filter((f) => isUserEditable(f.type) || f.type === "relation");
    if (usable.length === 0) {
      prompts.error("No editable fields. Add a field first.");
      return;
    }
    let audit: RecordMutationAudit | undefined;
    const result = await openRecordUpsertDialog({
      mode: "edit",
      fields: visibleFields(),
      baseId: props.baseId,
      tableName: props.tableName,
      record: rec,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      beforeSubmit: async (payload) => {
        const changedFieldIds = Object.keys(payload).filter(
          (fieldId) => JSON.stringify(payload[fieldId]) !== JSON.stringify(rec.data[fieldId]),
        );
        const requirement = recordAuditRequirementFor(props.auditPolicy, "update", changedFieldIds);
        if (!requirement) {
          audit = undefined;
          return true;
        }
        const answer = await openRecordAuditDialog({
          operation: "update",
          requirement,
          recordTitle: recordDisplayTitle({
            fields: props.fields,
            record: rec,
            fieldsByTable: props.fieldsByTable,
            relationLabels: props.relationLabels,
            dateConfig: props.dateConfig,
            viewColumns: props.viewColumns,
          }),
        });
        if (!answer) return false;
        audit = answer;
        return true;
      },
    });
    if (!result) return;
    updateMut.mutate({ rec, payload: result, audit });
  };

  const handleDelete = async (rec: GridRecord) => {
    if (deleteMut.loading()) return;
    const title = recordDisplayTitle({
      fields: props.fields,
      record: rec,
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      viewColumns: props.viewColumns,
    });
    const requirement = recordAuditRequirementFor(props.auditPolicy, "delete");
    const audit = requirement ? await openRecordAuditDialog({ operation: "delete", requirement, recordTitle: title }) : undefined;
    if (requirement && !audit) return;
    if (
      !requirement &&
      !(await prompts.confirm(`${title}\n${props.tableName}\n\nThis record is moved to trash and can be restored.`, {
        title: "Move record to trash?",
        variant: "danger",
        confirmText: "Move to trash",
      }))
    ) {
      return;
    }
    deleteMut.mutate({ rec, audit: audit ?? undefined });
  };

  const handleRestore = async (rec: GridRecord) => {
    if (restoreMut.loading()) return;
    const requirement = recordAuditRequirementFor(props.auditPolicy, "restore");
    const audit = requirement
      ? await openRecordAuditDialog({
          operation: "restore",
          requirement,
          recordTitle: recordDisplayTitle({
            fields: props.fields,
            record: rec,
            fieldsByTable: props.fieldsByTable,
            relationLabels: props.relationLabels,
            dateConfig: props.dateConfig,
            viewColumns: props.viewColumns,
          }),
        })
      : undefined;
    if (requirement && !audit) return;
    restoreMut.mutate({ rec, audit: audit ?? undefined });
  };

  const handleCreateCorrection = async (rec: GridRecord, launcher: WorkspaceRecordLauncher) => {
    if (createCorrectionMut.loading()) return;
    const confirmed = await prompts.confirm(
      `Create a new editable Draft linked to this finalized Record?\n\nThe original remains unchanged and locked. The new Draft uses the Table's normal defaults and numbering rules; values are not copied automatically.`,
      {
        title: launcher.name,
        icon: "ti ti-file-pencil",
        confirmText: "Create correction Draft",
      },
    );
    if (confirmed) {
      const key = `${launcher.id}:${rec.id}`;
      if (correctionOperation?.key !== key) correctionOperation = { key, id: crypto.randomUUID() };
      createCorrectionMut.mutate({ rec, launcher, operationId: correctionOperation.id });
    }
  };

  const handleFinalize = async (rec: GridRecord) => {
    if (finalizeMut.loading()) return;
    let readiness = finalization();
    if (!readiness) {
      try {
        readiness = await refreshFinalization(rec);
      } catch (error) {
        prompts.error(error instanceof Error ? error.message : "Could not check Finalization requirements");
        return;
      }
    }
    if (!readiness.enabled) {
      prompts.error("Finalization is not enabled for this table.");
      return;
    }
    if (readiness.missing.length > 0) {
      prompts.error(
        `Complete these fields before finalizing:\n\n${readiness.missing.map((item) => `• ${item.fieldName}: ${item.message}`).join("\n")}`,
      );
      return;
    }
    if (readiness.mode === "fourEyes") {
      const result = await prompts.form({
        title: "Request Finalization",
        icon: "ti ti-user-check",
        confirmText: "Request Finalization",
        fields: {
          info: {
            type: "info" as const,
            content:
              "A different current member of the Table's approver group must review this exact Record version before it can be finalized.",
          },
          comment: {
            type: "text" as const,
            label: "Comment",
            description: "Optional context for the reviewer.",
            multiline: true,
            lines: 3,
            maxLength: 2_000,
          },
        },
      });
      if (result) requestFinalizationMut.mutate({ rec, comment: result.comment?.trim() || null });
      return;
    }
    const assigned = readiness.assignedOnFinalization.map((item) => item.fieldName);
    const confirmed = await prompts.confirm(
      `${recordDisplayTitle({ fields: props.fields, record: rec, fieldsByTable: props.fieldsByTable, relationLabels: props.relationLabels, dateConfig: props.dateConfig, viewColumns: props.viewColumns })}\n\n${assigned.length ? `IDs assigned now: ${assigned.join(", ")}\n\n` : ""}After finalization, this record and its files and relations can no longer be changed or removed.`,
      { title: "Finalize record?", confirmText: "Finalize", variant: "danger" },
    );
    if (confirmed) finalizeMut.mutate(rec);
  };

  const resolveFinalizationRequest = async (rec: GridRecord, operation: "approve" | "reject") => {
    if (resolutionLoading()) return;
    const requestId = finalization()?.request?.id;
    if (!requestId) {
      prompts.error("The Finalization request changed. Refresh and review the current request.");
      return;
    }
    const result = await prompts.form({
      title: operation === "approve" ? "Approve and finalize Record?" : "Reject Finalization request?",
      icon: operation === "approve" ? "ti ti-lock-check" : "ti ti-user-x",
      confirmText: operation === "approve" ? "Approve and finalize" : "Reject request",
      ...(operation === "approve" ? { variant: "danger" as const } : {}),
      fields: {
        info: {
          type: "info" as const,
          content:
            operation === "approve"
              ? "Approval immediately finalizes this exact Record version. Its values, files, and relations can no longer be changed or removed."
              : "The Record remains editable and can be submitted again later.",
        },
        comment: {
          type: "text" as const,
          label: "Comment",
          description: "Optional context recorded with this decision.",
          multiline: true,
          lines: 3,
          maxLength: 2_000,
        },
      },
    });
    if (!result) return;
    const input = { rec, requestId, comment: result.comment?.trim() || null };
    if (operation === "approve") approveFinalizationMut.mutate(input);
    else rejectFinalizationMut.mutate(input);
  };

  return (
    <Show when={record()} fallback={null} keyed>
      {(rec) => (
        <RecordReadView
          cloudUrl={props.cloudUrl}
          baseId={props.baseId}
          tableId={props.tableId}
          tableName={props.tableName}
          fields={props.fields}
          record={rec}
          mode={mode()}
          showFinalizationStatus={Boolean(rec.finalizedAt || finalization()?.enabled)}
          relationLabels={props.relationLabels}
          fieldsByTable={props.fieldsByTable}
          viewColumns={props.viewColumns}
          dateConfig={props.dateConfig}
          scrollPreserveKey={`grids-record-detail-${props.tableId}-${rec.id}`}
          renderFileField={(field, record) => (
            <RecordFileField
              tableId={props.tableId}
              recordId={record.id}
              field={field}
              canWrite={props.canWrite && mode() === "live" && !record.finalizedAt}
              initialFiles={props.detail()?.filesByField[field.id] ?? []}
              onChanged={refreshAfterFinalizationMutation}
            />
          )}
          headerActions={
            <>
              <Show when={props.canWrite && mode() === "live" && !rec.finalizedAt}>
                <Dropdown.Root
                  position="bottom-left"
                  items={[
                    {
                      sectionLabel: "Danger zone",
                      items: [
                        {
                          label: "Move to trash",
                          icon: "ti ti-trash",
                          variant: "danger",
                          action: () => handleDelete(rec),
                        },
                      ],
                    },
                  ]}
                >
                  <Dropdown.Trigger
                    iconOnly
                    variant="ghost"
                    size="sm"
                    type="button"
                    label="More record actions"
                    disabled={deleteMut.loading()}
                    tooltip="More record actions"
                  >
                    <i class={deleteMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Tooltip.Anchor content="Close details">
                <IconButton variant="ghost" size="sm" type="button" label="Close detail panel" onClick={() => props.onClose()}>
                  <i class="ti ti-x" />
                </IconButton>
              </Tooltip.Anchor>
            </>
          }
          quickActions={
            <>
              <Show when={props.canRunWorkflows && mode() === "live" && rec.finalizedAt && props.recordActionLaunchers.length > 0}>
                <Dropdown.Root
                  position="bottom-left"
                  items={[
                    {
                      items: props.recordActionLaunchers.map((launcher) => ({
                        label: launcher.name,
                        icon: "ti ti-file-pencil",
                        description: "Create a linked editable Draft without changing this final Record.",
                        action: () => void handleCreateCorrection(rec, launcher),
                      })),
                    },
                  ]}
                >
                  <Dropdown.Trigger
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={createCorrectionMut.loading()}
                    loading={createCorrectionMut.loading()}
                    loadingLabel="Creating correction Draft"
                  >
                    <i class="ti ti-file-pencil" /> Create correction
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Show when={props.canWrite && mode() === "live" && !rec.finalizedAt}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  aria-label="Edit record"
                  onClick={() => handleEdit(rec)}
                  disabled={updateMut.loading()}
                >
                  <i class="ti ti-pencil" /> Edit
                </Button>
                <Show when={finalization()?.enabled}>
                  <Show
                    when={finalization()?.request?.status === "pending"}
                    fallback={
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => void handleFinalize(rec)}
                        loading={finalizeMut.loading() || requestFinalizationMut.loading()}
                        loadingLabel={finalization()?.mode === "fourEyes" ? "Requesting Finalization" : "Finalizing Record"}
                      >
                        <i class={finalization()?.mode === "fourEyes" ? "ti ti-user-check" : "ti ti-lock"} />
                        {finalization()?.mode === "fourEyes" ? "Request Finalization" : "Finalize"}
                      </Button>
                    }
                  >
                    <Show when={finalization()?.canResolveRequest}>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => void resolveFinalizationRequest(rec, "reject")}
                        loading={rejectFinalizationMut.loading()}
                        disabled={resolutionLoading()}
                        loadingLabel="Rejecting request"
                      >
                        <i class="ti ti-x" /> Reject
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        onClick={() => void resolveFinalizationRequest(rec, "approve")}
                        loading={approveFinalizationMut.loading()}
                        disabled={resolutionLoading()}
                        loadingLabel="Finalizing Record"
                      >
                        <i class="ti ti-lock-check" /> Approve and finalize
                      </Button>
                    </Show>
                  </Show>
                </Show>
              </Show>
              <Show when={props.canWrite && mode() === "trash"}>
                <Button variant="secondary" size="sm" type="button" onClick={() => handleRestore(rec)} disabled={restoreMut.loading()}>
                  <i class="ti ti-arrow-back-up" /> Restore
                </Button>
              </Show>
            </>
          }
          relationsAfter={
            <Show when={mode() === "live" && props.detail() && !props.detail()?.combinedOrigin}>
              <RecordReferencedBy baseId={props.baseId} tableId={props.tableId} recordId={rec.id} />
            </Show>
          }
        >
          <Show
            when={
              finalizationQueryEnabled() &&
              (finalizationQuery.loading() || finalizationQuery.stale()) &&
              !finalization() &&
              !finalizationQuery.error()
            }
          >
            <NoticeCard
              tone="neutral"
              title="Loading Finalization status"
              detail="Checking whether this Record needs Finalization review."
            />
          </Show>
          <Show when={finalizationQueryEnabled() && finalizationQuery.error()}>
            {(error) => (
              <NoticeCard tone="danger" title="Finalization status unavailable" detail={error().message}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refreshFinalization(rec).catch(() => undefined)}
                  loading={finalizationQuery.loading() || finalizationQuery.refreshing()}
                  loadingLabel="Refreshing Finalization"
                >
                  <i class="ti ti-refresh" /> Retry
                </Button>
              </NoticeCard>
            )}
          </Show>
          <Show when={finalization()?.request?.status === "pending"}>
            <NoticeCard
              tone="info"
              title="Finalization requested"
              detail={`${finalization()!.request!.requestedByDisplayName} requested review on ${formatDateTime(finalization()!.request!.requestedAt)}.${
                finalization()!.request!.requestComment ? ` ${finalization()!.request!.requestComment}` : ""
              }${finalization()!.resolutionDisabledReason ? ` ${finalization()!.resolutionDisabledReason}` : ""}`}
            />
          </Show>
          <Show when={finalization()?.enabled && finalization()?.mode === "fourEyes" && !finalizationQuery.error()}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => void refreshFinalization(rec).catch(() => undefined)}
              loading={finalizationQuery.loading() || finalizationQuery.refreshing()}
              loadingLabel="Refreshing Finalization"
            >
              <i class="ti ti-refresh" /> Refresh Finalization
            </Button>
          </Show>
          <Show when={finalization()?.request?.status === "rejected" || finalization()?.request?.status === "superseded"}>
            <NoticeCard
              tone="neutral"
              title={
                finalization()!.request!.status === "rejected" ? "Finalization request rejected" : "Previous request no longer applies"
              }
              detail={`${finalization()!.request!.resolvedByDisplayName ?? "The system"} resolved the request${
                finalization()!.request!.resolvedAt ? ` on ${formatDateTime(finalization()!.request!.resolvedAt!)}` : ""
              }.${finalization()!.request!.resolutionComment ? ` ${finalization()!.request!.resolutionComment}` : ""}`}
            />
          </Show>
          <Show when={props.detail()?.combinedOrigin}>
            {(origin) => (
              <DetailPanel.Group label="Combined record source">
                <DetailPanel.Section title="Combined source" icon="ti ti-stack-2" tone="neutral">
                  <DescriptionList
                    layout="rows"
                    size="sm"
                    items={[
                      {
                        term: "Published from",
                        description: `${origin().source.baseName} · ${origin().source.tableName}`,
                      },
                      ...(origin().deletedAt
                        ? [
                            {
                              term: "Deleted",
                              description: <time dateTime={origin().deletedAt!}>{formatDateTime(origin().deletedAt!)}</time>,
                            },
                          ]
                        : []),
                      {
                        term: "Access",
                        description: "Read-only publication. Restore or edit this record in its source table.",
                      },
                    ]}
                  />
                </DetailPanel.Section>
              </DetailPanel.Group>
            )}
          </Show>
          <RecordDocumentsSection
            cloudUrl={props.cloudUrl}
            tableId={props.tableId}
            recordId={rec.id}
            live={mode() === "live"}
            templates={props.documentTemplates}
            initialRuns={props.detail()?.documentRuns ?? []}
            initialSnapshots={props.detail()?.snapshots ?? []}
          />
          <Show when={mode() === "live"}>
            <RecordComments
              endpoint={`/api/grids/records/${encodeURIComponent(props.tableId)}/${encodeURIComponent(rec.id)}/comments`}
              dateConfig={props.dateConfig}
            />
          </Show>
          <Show when={mode() === "live" && !props.detail()?.combinedOrigin}>
            <RecordVersions tableId={props.tableId} recordId={rec.id} />
          </Show>
          <RecordHistorySection entries={props.detail()?.auditEntries ?? []} fields={props.fields} dateConfig={props.dateConfig} />
        </RecordReadView>
      )}
    </Show>
  );
}
