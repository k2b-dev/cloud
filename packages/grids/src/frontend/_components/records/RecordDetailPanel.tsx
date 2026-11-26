import { accessMemberEntries } from "@k2b/cloud/access/ui";
import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { DetailAccess, type DetailLinkItem, prompts, toast, useLocale } from "@k2b/ui";
import { type Action, Bar, Button, Canvas, Facts, Menu, type MenuEntry, Notice, Pane, Prose, RecordHead, Section } from "@k2b/ui/v2";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { PublicRecordFinalizationReadiness, PublicRecordFinalizationRequest } from "../../../api/record-finalization";
import type { ColumnSpec, RecordMutationAudit, TableAuditPolicy } from "../../../contracts";
import { recordAuditRequirementFor } from "../../../record-audit-policy";
import { type CorrectionDraftIntent, correctionDraftIntent } from "../../../workflows/contracts";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import { isUserEditable } from "../fields/field-prompt-schema";
import { fieldTypeIcon } from "../fields/field-type-meta";
import { FieldValue } from "../table/FieldValue";
import { resolveFieldDisplay } from "../table/field-display";
import { errorMessage } from "../utils/api-helpers";
import { createRetryToasts } from "../utils/feedback";
import type {
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { recordMessages } from "./messages";
import { openRecordAuditDialog } from "./RecordAuditDialog";
import RecordComments from "./RecordComments";
import RecordDocumentsSection from "./RecordDocumentsSection";
import RecordFileField from "./RecordFileField";
import RecordHistorySection from "./RecordHistorySection";
import { hasRecordDetailValue } from "./RecordReadView";
import { RecordLinks } from "./RecordReferencedBy";
import { openRecordUpsertDialog, RecordSaveConflictError } from "./RecordUpsertDialog";
import RecordVersions from "./RecordVersions";
import type { RecordAccess } from "./record-access";
import { CorrectionDraftInvocationError, createCorrectionDraft } from "./record-correction";
import { fieldDisplayFormatForView, recordDisplayTitle, recordTitleField } from "./record-display";

type Props = {
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
  /** Server time for the same history on the server and the first browser render. */
  now?: string;
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
  /** The way back to the list on the phone: the list's address without the open record. */
  back: Action;
  /** Who has access to the base, read-only; it loads once the first record opens. */
  access?: RecordAccess;
  /** The viewer, marked as "You" among the people with access. */
  currentUserId?: string;
};

const recordLauncherIntent = (launcher: WorkspaceRecordLauncher): CorrectionDraftIntent =>
  launcher.config.kind === "record" ? correctionDraftIntent(launcher.config) : "correction";

export default function RecordDetailPanel(props: Props) {
  const locale = useLocale();
  createEffect(() => props.access?.load());
  const t = () => recordMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
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
  /** The change was saved, only the finalization state is stale, so Retry repeats the refresh, not the change. */
  const refreshAfterFinalizationMutation = (): void => {
    void (async () => {
      await finalizationQuery.refresh();
      if (finalizationQuery.error()) throw finalizationQuery.error();
    })().catch(() => retryToast(t().successRefreshFailed, { retryLabel: t().retry, retry: refreshAfterFinalizationMutation }));
  };

  // ---- Mutations ---------------------------------------------------------
  const [updating, setUpdating] = createSignal(false);
  const updateRecord = async (rec: GridRecord, payload: Record<string, unknown>, audit?: RecordMutationAudit, version = rec.version) => {
    setUpdating(true);
    try {
      const res = await apiClient.records[":tableId"][":recordId"].$patch(
        {
          param: { tableId: props.tableId, recordId: rec.id },
          json: { values: payload, audit },
        },
        { headers: { "If-Match": String(version) } },
      );
      if (res.status === 409) throw new RecordSaveConflictError(await errorMessage(res, t().updateFailed));
      if (!res.ok) throw new Error(await errorMessage(res, t().updateFailed));
      props.onUpdated(await res.json());
    } finally {
      setUpdating(false);
    }
  };

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
    onError: (e) => toast.error(e.message),
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
    onError: (e) => toast.error(e.message),
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
      toast.error(error.message);
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
    await openRecordUpsertDialog({
      mode: "edit",
      fields: visibleFields(),
      baseId: props.baseId,
      tableName: props.tableName,
      record: rec,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      onSubmit: (payload, version) => updateRecord(rec, payload, audit, version),
      reloadRecord: async () => {
        const response = await apiClient.records[":tableId"][":recordId"].$get({
          param: { tableId: props.tableId, recordId: rec.id },
          query: {},
        });
        if (!response.ok) throw new Error(await errorMessage(response, t().updateFailed));
        return response.json();
      },
      beforeSubmit: async (payload, baselineData) => {
        const changedFieldIds = Object.keys(payload).filter(
          (fieldId) => JSON.stringify(payload[fieldId]) !== JSON.stringify(baselineData[fieldId]),
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

  const editable = (rec: GridRecord) => props.canWrite && mode() === "live" && !rec.finalizedAt;
  const reviewPending = () => finalization()?.request?.status === "pending";
  const canResolveReview = () => reviewPending() && Boolean(finalization()?.canResolveRequest);
  const fourEyes = () => finalization()?.mode === "fourEyes";
  // While one of the menu's commands runs, its entries stay disabled.
  const menuBusy = () =>
    deleteMut.loading() || finalizeMut.loading() || requestFinalizationMut.loading() || rejectFinalizationMut.loading();
  // ── v2 render ──────────────────────────────────────────────────────
  const cloudId = useCloudIdCopy();
  const cloudIdText = () => cloudIdMessages.resolve([locale()]).t;
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(value));
  const shown = () => visibleFields();
  const titleField = () => recordTitleField(shown());
  const bodyFields = () => shown().filter((field) => field.id !== titleField()?.id);
  const formatOf = (field: Field) => fieldDisplayFormatForView(field, props.viewColumns);
  /** Fields whose value reads in a line beside its label. */
  const factFields = () => bodyFields().filter((field) => !["longtext", "json", "object_list", "file", "relation"].includes(field.type));
  /** Long values people read: they stand open in sections of their own. */
  const longFields = (rec: GridRecord) =>
    bodyFields().filter((field) => ["longtext", "json", "object_list"].includes(field.type) && hasRecordDetailValue(rec.data[field.id]));
  const fileFields = () => bodyFields().filter((field) => field.type === "file");
  const value = (field: Field, rec: GridRecord) => (
    <FieldValue
      field={field}
      value={rec.data[field.id]}
      record={rec}
      allFields={props.fields}
      baseId={props.baseId}
      fieldsByTable={props.fieldsByTable}
      relationLabels={props.relationLabels}
      dateConfig={props.dateConfig}
      format={formatOf(field)}
      mode="detail"
      empty="—"
      linkLookup
      showBarcodeOpenAction
    />
  );
  const title = (rec: GridRecord) =>
    recordDisplayTitle({
      fields: props.fields,
      record: rec,
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      viewColumns: props.viewColumns,
    });
  /** The record's state as a word: in the bin, finalized, or a draft while finalization is on. */
  const stateWord = (rec: GridRecord) =>
    mode() === "trash" ? t().deleted : rec.finalizedAt ? t().finalized : finalization()?.enabled ? t().finalizationDraft : undefined;

  /** Each relation value as a link row: the field, then the linked record; an empty relation stays a disabled row. */
  const outgoingLinks = (rec: GridRecord): DetailLinkItem[] =>
    bodyFields()
      .filter((field) => field.type === "relation")
      .flatMap((field): DetailLinkItem[] => {
        const intent = resolveFieldDisplay({ field, value: rec.data[field.id], relationLabels: props.relationLabels, locale: locale() });
        const items = intent.kind === "relation" ? intent.items : [];
        const targetTableId = (field.config as { targetTableId?: string }).targetTableId;
        const icon = fieldTypeIcon(field.type, field.icon);
        if (items.length === 0 || !targetTableId)
          return [{ id: field.id, title: `${field.name} · —`, description: field.description ?? undefined, icon, disabled: true }];
        return items.map((item) => ({
          id: `${field.id}:${item.id}`,
          title: `${field.name} · ${item.label}`,
          description: field.description ?? undefined,
          icon,
          href: `/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(targetTableId)}?record=${encodeURIComponent(item.id)}`,
        }));
      });

  /** The rarer commands on the record, as v1's "…" offered them, and the record's Cloud ID. */
  const menuEntries = (rec: GridRecord): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    if (editable(rec)) {
      const finalizationEnabled = Boolean(finalization()?.enabled);
      if (canResolveReview()) {
        entries.push({ label: t().edit, icon: "pencil", disabled: menuBusy(), onClick: () => void handleEdit(rec) });
        entries.push({ label: t().reject, icon: "x", disabled: menuBusy(), onClick: () => void resolveFinalizationRequest(rec, "reject") });
      }
      if (finalizationEnabled && !reviewPending())
        entries.push({
          label: fourEyes() ? t().requestFinalization : t().finalize,
          icon: fourEyes() ? "user-check" : "lock",
          disabled: menuBusy(),
          onClick: () => void handleFinalize(rec),
        });
      if (finalizationEnabled && fourEyes() && !finalizationQuery.error())
        entries.push({
          label: t().refreshFinalization,
          icon: "refresh",
          onClick: () => void refreshFinalization(rec).catch(() => undefined),
        });
    }
    if (mode() === "live" && cloudId.available())
      entries.push({ label: cloudIdText().copy, icon: "link", onClick: () => cloudId.copy({ type: "grids.record", id: rec.id }) });
    if (editable(rec))
      entries.push({ label: t().moveToTrash, icon: "trash", danger: true, disabled: menuBusy(), onClick: () => void handleDelete(rec) });
    return entries;
  };

  const correctionEntries = (rec: GridRecord): MenuEntry[] =>
    props.recordActionLaunchers.map((launcher) => ({
      label: launcher.name,
      icon: recordLauncherIntent(launcher) === "cancellation" ? "file-off" : "file-pencil",
      meta:
        launcher.correctionPrefillFieldCount === 0
          ? t().emptyLinkedDraft({ intent: intentLabel(recordLauncherIntent(launcher)) })
          : t().prefilledLinkedDraft({ intent: intentLabel(recordLauncherIntent(launcher)), count: launcher.correctionPrefillFieldCount }),
      onClick: () => void handleCreateCorrection(rec, launcher),
    }));
  const correctionLabel = () =>
    sharedRecordActionIntent() === "cancellation"
      ? t().createCancellation
      : sharedRecordActionIntent() === "correction"
        ? t().createCorrection
        : t().createFollowUp;

  return (
    <Show when={record()} keyed>
      {(rec) => (
        <RecordDocumentsSection
          tableId={props.tableId}
          tableName={props.tableName}
          recordId={rec.id}
          live={mode() === "live"}
          canWrite={props.canWrite}
          templates={props.documentTemplates}
          initialDocuments={props.detail()?.documents ?? { items: [], cursor: null, hasMore: false }}
          initialSnapshots={props.detail()?.snapshots ?? []}
        >
          {(documents) => (
            <Pane
              detail
              label={title(rec)}
              width={{ min: 400, default: 480 }}
              back={props.back}
              scrollKey={`grids-record-detail-${props.tableId}-${rec.id}`}
              head={
                <Bar
                  start={
                    <RecordHead
                      name={title(rec)}
                      kinds={[props.tableName, ...(stateWord(rec) ? [stateWord(rec) as string] : [])]}
                      ids={[{ label: t().versionSection, value: String(rec.version) }]}
                    />
                  }
                  end={
                    <>
                      <Show when={props.canRunWorkflows && mode() === "live" && rec.finalizedAt && props.recordActionLaunchers.length > 0}>
                        <Menu
                          icon={sharedRecordActionIntent() === "cancellation" ? "file-off" : "file-pencil"}
                          disabled={createCorrectionMut.loading()}
                          items={correctionEntries(rec)}
                        >
                          {correctionLabel()}
                        </Menu>
                      </Show>
                      <Show when={editable(rec)}>
                        <Show
                          when={canResolveReview()}
                          fallback={
                            <Button icon="pencil" busy={updating()} onClick={() => void handleEdit(rec)}>
                              {t().edit}
                            </Button>
                          }
                        >
                          <Button
                            icon="lock-check"
                            busy={approveFinalizationMut.loading()}
                            disabled={resolutionLoading()}
                            onClick={() => void resolveFinalizationRequest(rec, "approve")}
                          >
                            {t().approveFinalize}
                          </Button>
                        </Show>
                      </Show>
                      <Show when={props.canWrite && mode() === "trash"}>
                        <Button icon="arrow-back-up" busy={restoreMut.loading()} onClick={() => void handleRestore(rec)}>
                          {t().restore}
                        </Button>
                      </Show>
                      <Show when={menuEntries(rec).length > 0}>
                        <Menu label={t().moreActions} items={menuEntries(rec)} />
                      </Show>
                      <Button variant="ghost" icon="x" label={t().closePanel} onClick={() => props.onClose()} />
                    </>
                  }
                />
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
                <Notice tone="note" title={t().loadingFinalization}>
                  {t().checkingFinalization}
                </Notice>
              </Show>
              <Show when={finalizationQueryEnabled() && finalizationQuery.error()}>
                {(error) => (
                  <Notice
                    tone="bad"
                    title={t().finalizationUnavailable}
                    actions={[{ label: t().retry, icon: "refresh", onClick: () => void refreshFinalization(rec).catch(() => undefined) }]}
                  >
                    {error().message}
                  </Notice>
                )}
              </Show>
              <Show when={reviewPending() ? finalization()?.request : undefined}>
                {(request) => (
                  <Notice tone="warn" icon="user-check" title={t().finalizationRequested}>
                    {`${t().reviewRequested({ name: request().requestedByDisplayName, date: formatDateTime(request().requestedAt) })}${
                      request().requestComment ? ` ${request().requestComment}` : ""
                    }${finalization()?.resolutionDisabledReason ? ` ${finalization()?.resolutionDisabledReason}` : ""}`}
                  </Notice>
                )}
              </Show>
              <Show
                when={
                  finalization()?.request?.status === "rejected" || finalization()?.request?.status === "superseded"
                    ? finalization()?.request
                    : undefined
                }
              >
                {(request) => (
                  <Notice tone="note" title={request().status === "rejected" ? t().requestRejected : t().requestSuperseded}>
                    {`${t().requestResolved({ name: request().resolvedByDisplayName ?? t().system, date: request().resolvedAt ? formatDateTime(request().resolvedAt as string) : "" })}${request().resolutionComment ? ` ${request().resolutionComment}` : ""}`}
                  </Notice>
                )}
              </Show>

              <Section icon="list-details" title={t().fieldsSection}>
                <Facts items={factFields().map((field) => ({ label: field.name, value: value(field, rec) }))} />
              </Section>
              <For each={longFields(rec)}>
                {(field) =>
                  field.type === "longtext" && typeof rec.data[field.id] === "string" ? (
                    <Section icon="align-left" title={field.name}>
                      <Prose markdown={rec.data[field.id] as string} />
                    </Section>
                  ) : (
                    // k2b-ui gap: JSON and object lists have no v2 reader yet; their own drawing stays.
                    <Section icon="braces" title={field.name}>
                      <Canvas label={field.name}>{value(field, rec)}</Canvas>
                    </Section>
                  )
                }
              </For>
              <Show when={fileFields().length > 0 || props.documentTemplates.length > 0}>
                {/* k2b-ui gap: files with previews, upload by dropping and documents wait for Tiles media (lane DP/Y2);
                    they keep their own drawing and every deed. */}
                <Section icon="paperclip" title={t().filesSection}>
                  <Canvas label={t().filesSection}>
                    <For each={fileFields()}>
                      {(field) => (
                        <RecordFileField
                          tableId={props.tableId}
                          recordId={rec.id}
                          field={field}
                          canWrite={props.canWrite && mode() === "live" && !rec.finalizedAt}
                          initialFiles={props.detail()?.filesByField[field.id] ?? []}
                          onChanged={refreshAfterFinalizationMutation}
                        />
                      )}
                    </For>
                    {documents.documents}
                  </Canvas>
                </Section>
              </Show>
              <Show when={mode() === "live" && !props.detail()?.combinedOrigin}>
                {/* k2b-ui gap: linked and referencing records as rows with load more come with v2 list virtualization
                    (lane MW); the shared links section keeps its pages meanwhile. */}
                <Canvas label={t().linksSection}>
                  <RecordLinks
                    baseId={props.baseId}
                    tableId={props.tableId}
                    recordId={rec.id}
                    outgoing={outgoingLinks(rec)}
                    ready={props.detail()?.recordId === rec.id}
                    initialPage={props.detail()?.referencedBy}
                    revision={props.detail()}
                  />
                </Canvas>
                {/* The comment composer is a rich inner component: it keeps its own behaviour. */}
                <Canvas label={t().commentsSection}>
                  <RecordComments
                    endpoint={`/api/grids/records/${encodeURIComponent(props.tableId)}/${encodeURIComponent(rec.id)}/comments`}
                    dateConfig={props.dateConfig}
                  />
                </Canvas>
              </Show>
              <Show when={props.detail()?.combinedOrigin}>
                {(origin) => (
                  <Section icon="git-merge" title={t().combinedSource}>
                    <Facts
                      items={[
                        { label: t().publishedFromLabel, value: `${origin().source.baseName} · ${origin().source.tableName}` },
                        ...(origin().deletedAt ? [{ label: t().deleted, value: formatDate(origin().deletedAt as string) }] : []),
                        { label: t().access, value: t().readonlyPublication },
                      ]}
                    />
                  </Section>
                )}
              </Show>
              <Section icon="info-circle" title={t().technicalSection}>
                <Facts
                  items={[
                    { label: t().table, value: props.tableName },
                    { label: t().recordId, value: rec.id, mono: true, copy: rec.id },
                    { label: t().versionSection, value: String(rec.version) },
                    { label: t().created, value: formatDate(rec.createdAt) },
                    { label: t().updated, value: formatDate(rec.updatedAt) },
                  ]}
                />
              </Section>
              {/* k2b-ui gap: versions, history (activity with people) and access (people with avatars) wait for Digest
                  with people and Avatar.Stack (lane DP); their shared sections stay meanwhile. */}
              <Canvas label={t().historySection}>
                <Show when={mode() === "live" && !props.detail()?.combinedOrigin}>
                  <RecordVersions tableId={props.tableId} recordId={rec.id} />
                </Show>
                <RecordHistorySection
                  entries={props.detail()?.auditEntries ?? []}
                  fields={props.fields}
                  dateConfig={props.dateConfig}
                  now={props.now}
                />
                {documents.snapshots}
              </Canvas>
              <Show when={props.access}>
                {(access) => (
                  <Canvas label={t().access}>
                    <DetailAccess
                      entries={accessMemberEntries(access().members, { currentUserId: props.currentUserId, locale: locale() })}
                      state={access().state}
                      onRetry={access().retry}
                      note={t().accessWholeBase}
                    />
                  </Canvas>
                )}
              </Show>
            </Pane>
          )}
        </RecordDocumentsSection>
      )}
    </Show>
  );
}
