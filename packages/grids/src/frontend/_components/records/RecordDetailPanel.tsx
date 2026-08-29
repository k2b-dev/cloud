import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, DescriptionList, DetailPanel, Dropdown, IconButton, NoticeCard, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { PublicRecordFinalizationReadiness, PublicRecordFinalizationRequest } from "../../../api/record-finalization";
import type { ColumnSpec, RecordMutationAudit, TableAuditPolicy } from "../../../contracts";
import { recordAuditRequirementFor } from "../../../record-audit-policy";
import { type CorrectionDraftIntent, correctionDraftIntent } from "../../../workflows/contracts";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import { isUserEditable } from "../fields/field-prompt-schema";
import { errorMessage } from "../utils/api-helpers";
import type {
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { recordMessages } from "./messages";
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

const recordLauncherIntent = (launcher: WorkspaceRecordLauncher): CorrectionDraftIntent =>
  launcher.config.kind === "record" ? correctionDraftIntent(launcher.config) : "correction";

export default function RecordDetailPanel(props: Props) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  let disposed = false;
  let correctionOperation: { key: string; id: string } | null = null;
  let correctionRecordId: string | null = null;
  const record = () => props.record();
  const mode = () => props.mode();
  const intentLabel = (intent: CorrectionDraftIntent): string => (intent === "cancellation" ? t().cancellation : t().correction);
  const sharedRecordActionIntent = (): CorrectionDraftIntent | null => {
    const intents = new Set(props.recordActionLaunchers.map(recordLauncherIntent));
    return intents.size === 1 ? (intents.values().next().value ?? null) : null;
  };
  const finalizationQueryEnabled = () => {
    const rec = record();
    return Boolean(rec && props.canWrite && mode() === "live" && !rec.finalizedAt);
  };
  const finalizationQuery = query.create({
    source: record,
    enabled: finalizationQueryEnabled,
    load: async (rec, { abortSignal }) => {
      if (!rec) throw new Error(t().noRecordSelected);
      const response = await apiClient.records[":tableId"][":recordId"].finalization.$get(
        { param: { tableId: props.tableId, recordId: rec.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().finalizationRefreshFailed));
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
    if (record()?.id !== rec.id) throw new Error(t().selectedRecordChanged);
    await finalizationQuery.refresh();
    const refreshError = finalizationQuery.error();
    if (refreshError) throw refreshError;
    const readiness = finalization();
    if (!readiness) throw new Error(t().finalizationRefreshFailed);
    return readiness;
  }

  const reportFinalizationError = (error: Error) => {
    prompts.error(error.message);
    const rec = record();
    if (!rec) return;
    void refreshFinalization(rec).catch(() => prompts.error(t().actionRefreshFailed));
  };
  const refreshAfterFinalizationMutation = () => {
    void (async () => {
      await finalizationQuery.refresh();
      if (finalizationQuery.error()) throw finalizationQuery.error();
    })().catch(() => prompts.error(t().successRefreshFailed));
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
      if (!res.ok) throw new Error(await errorMessage(res, t().updateFailed));
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
      if (res.status >= 400) throw new Error(await errorMessage(res, t().deleteFailed));
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
      if (res.status >= 400) throw new Error(await errorMessage(res, t().restoreFailed));
      return rec.id;
    },
    onSuccess: () => props.onRemoved(),
    onError: (e) => prompts.error(e.message),
  });

  const createCorrectionMut = mutations.create<
    { recordId: string; tableId: string; originalRecordId: string; intent: CorrectionDraftIntent },
    { rec: GridRecord; launcher: WorkspaceRecordLauncher; operationId: string }
  >({
    mutation: async ({ rec, launcher, operationId }, { abortSignal }) => {
      const result = await createCorrectionDraft({
        launcherId: launcher.id,
        expectedRevision: launcher.workflowRevision,
        recordId: rec.id,
        operationId,
        signal: abortSignal,
        locale: locale(),
      });
      if (result.tableId !== props.tableId) {
        throw new CorrectionDraftInvocationError(t().linkedDraftWrongTable, false);
      }
      return { ...result, originalRecordId: rec.id, intent: recordLauncherIntent(launcher) };
    },
    onSuccess: (result) => {
      correctionOperation = null;
      correctionRecordId = null;
      if (!disposed && record()?.id === result.originalRecordId) props.onOpenRecord(result.recordId);
      const label = intentLabel(result.intent);
      toast.success(t().linkedDraftReady({ intent: label }), {
        title: result.intent === "cancellation" ? t().cancellationCreated : t().correctionCreated,
      });
    },
    onError: (error) => {
      correctionRecordId = null;
      if (error instanceof CorrectionDraftInvocationError && !error.retrySameOperation) correctionOperation = null;
      prompts.error(error.message);
    },
    onAbort: () => {
      correctionRecordId = null;
    },
  });

  createEffect(() => {
    const currentRecordId = record()?.id ?? null;
    if (correctionRecordId && currentRecordId !== correctionRecordId && createCorrectionMut.loading()) createCorrectionMut.abort();
  });

  onCleanup(() => {
    disposed = true;
    createCorrectionMut.abort();
  });

  const finalizeMut = mutations.create<GridRecord, GridRecord>({
    mutation: async (rec) => {
      const res = await apiClient.records[":tableId"][":recordId"].finalize.$post({
        param: { tableId: props.tableId, recordId: rec.id },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().finalizeFailed));
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
      if (!response.ok) throw new Error(await errorMessage(response, t().requestFinalizationFailed));
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
      if (!response.ok) throw new Error(await errorMessage(response, t().approveFinalizationFailed));
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
      if (!response.ok) throw new Error(await errorMessage(response, t().rejectFinalizationFailed));
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
      prompts.error(t().noEditableFieldsAdd);
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
      !(await prompts.confirm(t().movedToTrashDetail({ title, table: props.tableName }), {
        title: t().moveToTrashTitle,
        variant: "danger",
        confirmText: t().moveToTrash,
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
    const intent = recordLauncherIntent(launcher);
    const label = intentLabel(intent);
    const copySummary =
      launcher.correctionPrefillFieldCount === 0 ? t().noValuesCarried : t().valuesCarried({ count: launcher.correctionPrefillFieldCount });
    const confirmed = await prompts.confirm(
      t().createLinkedDraftConfirm({ intent: label, copy: copySummary, cancellation: intent === "cancellation" }),
      {
        title: launcher.name,
        icon: intent === "cancellation" ? "ti ti-file-off" : "ti ti-file-pencil",
        confirmText: intent === "cancellation" ? t().createCancellationDraft : t().createCorrectionDraft,
      },
    );
    if (!confirmed || disposed) return;
    const current = record();
    const currentLauncher = props.recordActionLaunchers.find((candidate) => candidate.id === launcher.id);
    if (
      !current ||
      current.id !== rec.id ||
      mode() !== "live" ||
      !current.finalizedAt ||
      !currentLauncher ||
      currentLauncher.updatedAt !== launcher.updatedAt ||
      currentLauncher.workflowRevision !== launcher.workflowRevision
    ) {
      return;
    }
    const key = `${launcher.id}:${rec.id}`;
    if (correctionOperation?.key !== key) correctionOperation = { key, id: crypto.randomUUID() };
    correctionRecordId = rec.id;
    createCorrectionMut.mutate({ rec, launcher: currentLauncher, operationId: correctionOperation.id });
  };

  const handleFinalize = async (rec: GridRecord) => {
    if (finalizeMut.loading()) return;
    let readiness = finalization();
    if (!readiness) {
      try {
        readiness = await refreshFinalization(rec);
      } catch (error) {
        prompts.error(error instanceof Error ? error.message : t().finalizationRefreshFailed);
        return;
      }
    }
    if (!readiness.enabled) {
      prompts.error(t().finalizationDisabled);
      return;
    }
    if (readiness.missing.length > 0) {
      prompts.error(
        t().completeBeforeFinalizing({ fields: readiness.missing.map((item) => `• ${item.fieldName}: ${item.message}`).join("\n") }),
      );
      return;
    }
    if (readiness.mode === "fourEyes") {
      const result = await prompts.form({
        title: t().requestFinalization,
        icon: "ti ti-user-check",
        confirmText: t().requestFinalization,
        fields: {
          info: {
            type: "info" as const,
            content: t().requestFinalizationInfo,
          },
          comment: {
            type: "text" as const,
            label: t().comment,
            description: t().reviewerContext,
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
      `${recordDisplayTitle({ fields: props.fields, record: rec, fieldsByTable: props.fieldsByTable, relationLabels: props.relationLabels, dateConfig: props.dateConfig, viewColumns: props.viewColumns })}\n\n${assigned.length ? `${t().idsAssigned({ ids: assigned.join(", ") })}\n\n` : ""}${t().finalizationLockDetail}`,
      { title: t().finalizeRecordTitle, confirmText: t().finalize, variant: "danger" },
    );
    if (confirmed) finalizeMut.mutate(rec);
  };

  const resolveFinalizationRequest = async (rec: GridRecord, operation: "approve" | "reject") => {
    if (resolutionLoading()) return;
    const requestId = finalization()?.request?.id;
    if (!requestId) {
      prompts.error(t().requestChanged);
      return;
    }
    const result = await prompts.form({
      title: operation === "approve" ? t().approveTitle : t().rejectTitle,
      icon: operation === "approve" ? "ti ti-lock-check" : "ti ti-user-x",
      confirmText: operation === "approve" ? t().approveFinalize : t().rejectRequest,
      ...(operation === "approve" ? { variant: "danger" as const } : {}),
      fields: {
        info: {
          type: "info" as const,
          content: operation === "approve" ? t().approvalDetail : t().rejectionDetail,
        },
        comment: {
          type: "text" as const,
          label: t().comment,
          description: t().decisionContext,
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
                      sectionLabel: t().dangerZone,
                      items: [
                        {
                          label: t().moveToTrash,
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
                    label={t().moreActions}
                    disabled={deleteMut.loading()}
                    tooltip={t().moreActions}
                  >
                    <i class={deleteMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Tooltip.Anchor content={t().closeDetails}>
                <IconButton variant="ghost" size="sm" type="button" label={t().closePanel} onClick={() => props.onClose()}>
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
                        icon: recordLauncherIntent(launcher) === "cancellation" ? "ti ti-file-off" : "ti ti-file-pencil",
                        description:
                          launcher.correctionPrefillFieldCount === 0
                            ? t().emptyLinkedDraft({ intent: intentLabel(recordLauncherIntent(launcher)) })
                            : t().prefilledLinkedDraft({
                                intent: intentLabel(recordLauncherIntent(launcher)),
                                count: launcher.correctionPrefillFieldCount,
                              }),
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
                    loadingLabel={
                      sharedRecordActionIntent() === "cancellation"
                        ? t().creatingCancellationDraft
                        : sharedRecordActionIntent() === "correction"
                          ? t().creatingCorrectionDraft
                          : t().creatingLinkedDraft
                    }
                  >
                    <i class={sharedRecordActionIntent() === "cancellation" ? "ti ti-file-off" : "ti ti-file-pencil"} />
                    {sharedRecordActionIntent() === "cancellation"
                      ? t().createCancellation
                      : sharedRecordActionIntent() === "correction"
                        ? t().createCorrection
                        : t().createFollowUp}
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Show when={props.canWrite && mode() === "live" && !rec.finalizedAt}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  aria-label={t().editRecordLabel}
                  onClick={() => handleEdit(rec)}
                  disabled={updateMut.loading()}
                >
                  <i class="ti ti-pencil" /> {t().edit}
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
                        loadingLabel={finalization()?.mode === "fourEyes" ? t().requestingFinalization : t().finalizingRecord}
                      >
                        <i class={finalization()?.mode === "fourEyes" ? "ti ti-user-check" : "ti ti-lock"} />
                        {finalization()?.mode === "fourEyes" ? t().requestFinalization : t().finalize}
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
                        loadingLabel={t().rejectingRequest}
                      >
                        <i class="ti ti-x" /> {t().reject}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        onClick={() => void resolveFinalizationRequest(rec, "approve")}
                        loading={approveFinalizationMut.loading()}
                        disabled={resolutionLoading()}
                        loadingLabel={t().finalizingRecord}
                      >
                        <i class="ti ti-lock-check" /> {t().approveFinalize}
                      </Button>
                    </Show>
                  </Show>
                </Show>
              </Show>
              <Show when={props.canWrite && mode() === "trash"}>
                <Button variant="secondary" size="sm" type="button" onClick={() => handleRestore(rec)} disabled={restoreMut.loading()}>
                  <i class="ti ti-arrow-back-up" /> {t().restore}
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
            <NoticeCard tone="neutral" title={t().loadingFinalization} detail={t().checkingFinalization} />
          </Show>
          <Show when={finalizationQueryEnabled() && finalizationQuery.error()}>
            {(error) => (
              <NoticeCard tone="danger" title={t().finalizationUnavailable} detail={error().message}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refreshFinalization(rec).catch(() => undefined)}
                  loading={finalizationQuery.loading() || finalizationQuery.refreshing()}
                  loadingLabel={t().refreshingFinalization}
                >
                  <i class="ti ti-refresh" /> {t().retry}
                </Button>
              </NoticeCard>
            )}
          </Show>
          <Show when={finalization()?.request?.status === "pending"}>
            <NoticeCard
              tone="info"
              title={t().finalizationRequested}
              detail={`${t().reviewRequested({ name: finalization()!.request!.requestedByDisplayName, date: formatDateTime(finalization()!.request!.requestedAt) })}${
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
              loadingLabel={t().refreshingFinalization}
            >
              <i class="ti ti-refresh" /> {t().refreshFinalization}
            </Button>
          </Show>
          <Show when={finalization()?.request?.status === "rejected" || finalization()?.request?.status === "superseded"}>
            <NoticeCard
              tone="neutral"
              title={finalization()!.request!.status === "rejected" ? t().requestRejected : t().requestSuperseded}
              detail={`${t().requestResolved({ name: finalization()!.request!.resolvedByDisplayName ?? t().system, date: finalization()!.request!.resolvedAt ? formatDateTime(finalization()!.request!.resolvedAt!) : "" })}${finalization()!.request!.resolutionComment ? ` ${finalization()!.request!.resolutionComment}` : ""}`}
            />
          </Show>
          <Show when={props.detail()?.combinedOrigin}>
            {(origin) => (
              <DetailPanel.Group label={t().combinedSourceGroup}>
                <DetailPanel.Section title={t().combinedSource} icon="ti ti-stack-2" tone="neutral">
                  <DescriptionList
                    layout="rows"
                    size="sm"
                    items={[
                      {
                        term: t().publishedFromLabel,
                        description: `${origin().source.baseName} · ${origin().source.tableName}`,
                      },
                      ...(origin().deletedAt
                        ? [
                            {
                              term: t().deleted,
                              description: <time dateTime={origin().deletedAt!}>{formatDateTime(origin().deletedAt!)}</time>,
                            },
                          ]
                        : []),
                      {
                        term: t().access,
                        description: t().readonlyPublication,
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
            tableName={props.tableName}
            recordId={rec.id}
            live={mode() === "live"}
            templates={props.documentTemplates}
            initialDocuments={props.detail()?.documents ?? { items: [], cursor: null, hasMore: false }}
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
