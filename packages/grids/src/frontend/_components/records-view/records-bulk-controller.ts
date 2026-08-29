import { mutation } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { z } from "zod";
import { apiClient } from "../../../api/client";
import type { PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkspaceBulkLauncher as WorkspaceBulkLauncher } from "../workspace/workspace-public-state-model";
import { bulkSelectionRunPayload, bulkWorkflowTargetLabel, pruneBulkSelection, sameBulkSelection } from "./bulk-selection";
import { recordsViewMessages } from "./messages";

type BulkWorkflowRunInput = {
  launcher: WorkspaceBulkLauncher;
  selectedRecordIds: string[];
  query: RecordQuery;
  inputs?: Record<string, string | number>;
};

type RecordsBulkControllerOptions = {
  baseId: string;
  tableId: string;
  enabled: Accessor<boolean>;
  items: Accessor<GridRecord[]>;
  query: Accessor<RecordQuery>;
  scopeKey: Accessor<string>;
  locale?: Accessor<string>;
};

type CloseSelectionBlocker = { recordId: string; reason: string };
export const MAX_CLOSE_SELECTION_RECORDS = 100;

const CloseSelectionPreviewSchema = z.object({
  items: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        recordId: z.string(),
        enabled: z.boolean(),
        mode: z.enum(["direct", "fourEyes"]).nullable(),
        policyRevision: z.number().int().positive().nullable(),
        finalized: z.boolean(),
        pendingRequest: z.boolean(),
        missingFieldNames: z.array(z.string()),
      }),
      z.object({ ok: z.literal(false), recordId: z.string(), reason: z.string() }),
    ]),
  ),
});

export const inspectCloseSelection = async (
  tableId: string,
  recordIds: readonly string[],
  signal?: AbortSignal,
  locale = "en",
): Promise<{ mode: "direct" | "fourEyes" | null; policyRevision: number | null; blockers: CloseSelectionBlocker[] }> => {
  const { t } = recordsViewMessages.resolve([locale]);
  const response = await fetch(`/api/grids/records/${encodeURIComponent(tableId)}/finalization/preview`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordIds }),
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response, t.previewFinalizationFailed));
  const { items } = CloseSelectionPreviewSchema.parse(await response.json());
  const failures: CloseSelectionBlocker[] = [];
  const policies = new Map<string, { mode: "direct" | "fourEyes"; policyRevision: number }>();
  for (const item of items) {
    if (!item.ok) failures.push({ recordId: item.recordId, reason: item.reason });
    else if (!item.enabled || !item.mode || !item.policyRevision) {
      failures.push({ recordId: item.recordId, reason: t.finalizationNotEnabled });
    } else {
      policies.set(`${item.mode}:${item.policyRevision}`, { mode: item.mode, policyRevision: item.policyRevision });
      if (item.finalized) failures.push({ recordId: item.recordId, reason: t.recordAlreadyFinalized });
      else if (item.pendingRequest) failures.push({ recordId: item.recordId, reason: t.finalizationRequestPending });
      else if (item.missingFieldNames.length > 0) {
        failures.push({ recordId: item.recordId, reason: t.completeFields({ names: item.missingFieldNames.join(", ") }) });
      }
    }
  }
  if (policies.size > 1) failures.push({ recordId: t.selection, reason: t.finalizationPolicyChanged });
  const policy = policies.values().next().value;
  if (!policy && failures.length > 0) return { mode: null, policyRevision: null, blockers: failures };
  if (!policy) throw new Error(t.finalizationPreviewEmpty);
  return { ...policy, blockers: failures };
};

export const createRecordsBulkController = (options: RecordsBulkControllerOptions) => {
  const t = () => recordsViewMessages.resolve([options.locale?.() ?? "en"]).t;
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [queueing, setQueueing] = createSignal(false);
  let selectionGeneration = 0;
  let previewAbort: AbortController | null = null;
  let disposed = false;
  const selectedCount = () => selectedIds().size;
  const replaceSelection = (next: Set<string>) => {
    selectionGeneration += 1;
    setSelectedIds(next);
  };
  const clear = () => replaceSelection(new Set<string>());

  const toggleRecord = (recordId: string, selected: boolean) => {
    const current = selectedIds();
    const next = new Set(current);
    if (selected) next.add(recordId);
    else next.delete(recordId);
    if (!sameBulkSelection(current, next)) replaceSelection(next);
  };

  const toggleVisible = (selected: boolean) => {
    const ids = options.items().map((record) => record.id);
    const current = selectedIds();
    const next = new Set(current);
    for (const id of ids) {
      if (selected) next.add(id);
      else next.delete(id);
    }
    if (!sameBulkSelection(current, next)) replaceSelection(next);
  };

  const runWorkflow = mutation.create<
    {
      runId: string;
      status: string;
      launcherName: string;
      workflowId: string;
      targetLabel: string;
      submittedRecordIds: string[];
    },
    BulkWorkflowRunInput
  >({
    mutation: async ({ launcher, selectedRecordIds, query, inputs }, { abortSignal }) => {
      const response = await apiClient.workflows.launchers[":launcherId"].invoke.bulk.$post(
        {
          param: { launcherId: launcher.id },
          json: {
            operationId: crypto.randomUUID(),
            mode: "execute",
            expectedRevision: launcher.workflowRevision,
            inputs: inputs ?? {},
            ...bulkSelectionRunPayload(selectedRecordIds, query),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().startWorkflowFailed));
      const run = await response.json();
      return {
        ...run,
        submittedRecordIds: selectedRecordIds,
        launcherName: launcher.name,
        workflowId: launcher.workflowId,
        targetLabel: bulkWorkflowTargetLabel(selectedRecordIds.length, options.locale?.() ?? "en"),
      };
    },
    onSuccess: (run) => {
      setQueueing(false);
      const next = new Set(selectedIds());
      for (const id of run.submittedRecordIds) next.delete(id);
      if (!sameBulkSelection(next, selectedIds())) replaceSelection(next);
      toast.success(t().workflowQueued({ name: run.launcherName, target: run.targetLabel }), {
        title: t().workflowQueuedTitle,
        duration: 10_000,
        action: {
          label: t().openRun,
          href: `/app/grids/${encodeURIComponent(options.baseId)}/workflows/${encodeURIComponent(
            run.workflowId,
          )}?run=${encodeURIComponent(run.runId)}`,
        },
      });
    },
    onError: (error) => {
      setQueueing(false);
      void prompts.error(error.message);
    },
  });

  const queueWorkflow = async (launcher: WorkspaceBulkLauncher) => {
    if (queueing() || runWorkflow.loading()) return;
    setQueueing(true);
    const selectedRecordIds = [...selectedIds()];
    const generation = selectionGeneration;
    const scopeKey = options.scopeKey();
    const unchanged = () => !disposed && generation === selectionGeneration && scopeKey === options.scopeKey();
    let launcherInputs: Record<string, string | number> | undefined;
    let submitted = false;
    try {
      const closesSelection =
        launcher.config.kind === "bulk" && "profile" in launcher.config && launcher.config.profile === "closeSelection";
      if (selectedRecordIds.length === 0 && closesSelection) {
        await prompts.error(t().selectRecordFirst, { title: t().noRecordsSelected });
        return;
      }
      if (closesSelection && selectedRecordIds.length > MAX_CLOSE_SELECTION_RECORDS) {
        await prompts.error(t().closeSelectionLimit({ count: MAX_CLOSE_SELECTION_RECORDS }), {
          title: t().selectionTooLarge,
        });
        return;
      }
      if (closesSelection) {
        previewAbort?.abort();
        previewAbort = new AbortController();
        const preview = await inspectCloseSelection(options.tableId, selectedRecordIds, previewAbort.signal, options.locale?.() ?? "en");
        if (!unchanged()) {
          if (!disposed) await prompts.error(t().selectionChanged);
          return;
        }
        if (preview.blockers.length > 0) {
          const shown = preview.blockers.slice(0, 12);
          await prompts.error(
            `${shown.map((blocker) => `• ${blocker.recordId}: ${blocker.reason}`).join("\n")}${
              preview.blockers.length > shown.length ? `\n• ${t().moreBlockers({ count: preview.blockers.length - shown.length })}` : ""
            }\n\n${t().blockersUnchanged}`,
            { title: t().recordsNotReady({ count: preview.blockers.length }) },
          );
          return;
        }
        if (!preview.mode || !preview.policyRevision) throw new Error(t().finalizationPreviewInactive);
        const action = preview.mode === "fourEyes" ? t().requestFinalization : t().finalizeSelectedRecords;
        const consequence = preview.mode === "fourEyes" ? t().requestFinalizationConsequence : t().finalizeConsequence;
        const confirmed = await prompts.confirm(t().confirmFinalization({ action, count: selectedRecordIds.length, consequence }), {
          title: action,
          icon: "ti ti-lock-check",
          confirmText: action,
        });
        if (!confirmed) return;
        if (!unchanged()) {
          if (!disposed) {
            await prompts.error(t().selectionChangedCurrent);
          }
          return;
        }
        launcherInputs = { closeMode: preview.mode, closePolicyRevision: preview.policyRevision };
      }
      if (selectedRecordIds.length === 0) {
        const confirmed = await prompts.confirm(t().confirmQueryWorkflow({ name: launcher.name }), {
          title: t().runForCurrentQuery,
          icon: "ti ti-list-check",
          confirmText: t().runWorkflow,
        });
        if (!confirmed) return;
      }
      if (!unchanged()) return;
      runWorkflow.mutate({ launcher, selectedRecordIds, query: options.query(), inputs: launcherInputs });
      submitted = true;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        await prompts.error(error instanceof Error ? error.message : t().previewFinalizationFailed, { title: t().nothingQueued });
      }
    } finally {
      previewAbort = null;
      if (!submitted) setQueueing(false);
    }
  };

  let previousScopeKey = "";
  createEffect(() => {
    const nextScopeKey = options.scopeKey();
    if (previousScopeKey && nextScopeKey !== previousScopeKey) {
      previewAbort?.abort();
      clear();
    }
    previousScopeKey = nextScopeKey;
  });

  createEffect(() => {
    if (!options.enabled()) {
      if (selectedCount() > 0) clear();
      return;
    }
    const visibleIds = new Set(options.items().map((record) => record.id));
    const current = selectedIds();
    const next = pruneBulkSelection(current, visibleIds);
    if (!sameBulkSelection(current, next)) replaceSelection(next);
  });

  onCleanup(() => {
    disposed = true;
    selectionGeneration += 1;
    previewAbort?.abort();
  });

  return { selectedIds, selectedCount, queueing, clear, toggleRecord, toggleVisible, queueWorkflow };
};
