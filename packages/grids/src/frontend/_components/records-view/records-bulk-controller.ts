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
): Promise<{ mode: "direct" | "fourEyes" | null; policyRevision: number | null; blockers: CloseSelectionBlocker[] }> => {
  const response = await fetch(`/api/grids/records/${encodeURIComponent(tableId)}/finalization/preview`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordIds }),
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Could not preview Finalization."));
  const { items } = CloseSelectionPreviewSchema.parse(await response.json());
  const failures: CloseSelectionBlocker[] = [];
  const policies = new Map<string, { mode: "direct" | "fourEyes"; policyRevision: number }>();
  for (const item of items) {
    if (!item.ok) failures.push({ recordId: item.recordId, reason: item.reason });
    else if (!item.enabled || !item.mode || !item.policyRevision) {
      failures.push({ recordId: item.recordId, reason: "Finalization is not enabled for this Table." });
    } else {
      policies.set(`${item.mode}:${item.policyRevision}`, { mode: item.mode, policyRevision: item.policyRevision });
      if (item.finalized) failures.push({ recordId: item.recordId, reason: "Record is already finalized." });
      else if (item.pendingRequest)
        failures.push({ recordId: item.recordId, reason: "Record already has a pending Finalization request." });
      else if (item.missingFieldNames.length > 0) {
        failures.push({ recordId: item.recordId, reason: `Complete: ${item.missingFieldNames.join(", ")}.` });
      }
    }
  }
  if (policies.size > 1) failures.push({ recordId: "Selection", reason: "The Table Finalization policy changed during preview." });
  const policy = policies.values().next().value;
  if (!policy && failures.length > 0) return { mode: null, policyRevision: null, blockers: failures };
  if (!policy) throw new Error("The Finalization preview did not return any Record result.");
  return { ...policy, blockers: failures };
};

export const createRecordsBulkController = (options: RecordsBulkControllerOptions) => {
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not start workflow."));
      const run = await response.json();
      return {
        ...run,
        submittedRecordIds: selectedRecordIds,
        launcherName: launcher.name,
        workflowId: launcher.workflowId,
        targetLabel: bulkWorkflowTargetLabel(selectedRecordIds.length),
      };
    },
    onSuccess: (run) => {
      setQueueing(false);
      const next = new Set(selectedIds());
      for (const id of run.submittedRecordIds) next.delete(id);
      if (!sameBulkSelection(next, selectedIds())) replaceSelection(next);
      toast.success(`${run.launcherName} queued for ${run.targetLabel}.`, {
        title: "Workflow queued",
        duration: 10_000,
        action: {
          label: "Open run",
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
        await prompts.error("Select at least one Record before running this action.", { title: "No Records selected" });
        return;
      }
      if (closesSelection && selectedRecordIds.length > MAX_CLOSE_SELECTION_RECORDS) {
        await prompts.error(
          `Close selection supports at most ${MAX_CLOSE_SELECTION_RECORDS} Records at once. Select fewer Records and try again.`,
          {
            title: "Selection is too large",
          },
        );
        return;
      }
      if (closesSelection) {
        previewAbort?.abort();
        previewAbort = new AbortController();
        const preview = await inspectCloseSelection(options.tableId, selectedRecordIds, previewAbort.signal);
        if (!unchanged()) {
          if (!disposed) await prompts.error("The Record selection changed while it was being reviewed. Review it and try again.");
          return;
        }
        if (preview.blockers.length > 0) {
          const shown = preview.blockers.slice(0, 12);
          await prompts.error(
            `${shown.map((blocker) => `• ${blocker.recordId}: ${blocker.reason}`).join("\n")}${
              preview.blockers.length > shown.length ? `\n• …and ${preview.blockers.length - shown.length} more` : ""
            }\n\nNothing was changed. Fix the blockers or select fewer Records and try again.`,
            { title: `${preview.blockers.length} Record${preview.blockers.length === 1 ? " is" : "s are"} not ready` },
          );
          return;
        }
        if (!preview.mode || !preview.policyRevision) throw new Error("The Finalization preview did not return an active policy.");
        const action = preview.mode === "fourEyes" ? "Request Finalization" : "Finalize selected Records";
        const consequence =
          preview.mode === "fourEyes"
            ? "Each exact Record will get a request bound to its current state. A different eligible person must approve it."
            : "Each exact Record will be permanently locked when its workflow step runs.";
        const confirmed = await prompts.confirm(
          `${action} for these ${selectedRecordIds.length} selected Records?\n\n${consequence}\n\nNew or unselected Records are not included. Every Record is checked again during the run.`,
          { title: action, icon: "ti ti-lock-check", confirmText: action },
        );
        if (!confirmed) return;
        if (!unchanged()) {
          if (!disposed) {
            await prompts.error("The Record selection changed while it was being reviewed. Review the current selection and try again.");
          }
          return;
        }
        launcherInputs = { closeMode: preview.mode, closePolicyRevision: preview.policyRevision };
      }
      if (selectedRecordIds.length === 0) {
        const confirmed = await prompts.confirm(
          `Run "${launcher.name}" for every record matching the current query? The server resolves the complete result set and stops without running if more than 10,000 records match.`,
          {
            title: "Run for current query",
            icon: "ti ti-list-check",
            confirmText: "Run workflow",
          },
        );
        if (!confirmed) return;
      }
      if (!unchanged()) return;
      runWorkflow.mutate({ launcher, selectedRecordIds, query: options.query(), inputs: launcherInputs });
      submitted = true;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        await prompts.error(error instanceof Error ? error.message : "Could not preview Finalization.", { title: "Nothing was queued" });
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
