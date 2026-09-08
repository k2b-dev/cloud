import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  AutocompleteEditor,
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  NoticeCard,
  PanelDialog,
  prompts,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import type { WorkflowBoundPlan, WorkflowDiagnostic } from "@valentinkolb/cloud/workflows";
import { createWorkflowYamlHighlighter } from "@valentinkolb/cloud/workflows/editor";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicTable } from "../../../api/public-dto";
import { PublicGridsWorkflowSchema, PublicWorkflowValidateResponseSchema } from "../../../api/workflow-public-contracts";
import { WORKFLOW_REVISION_HEADER, type WorkflowAutocompleteResponse } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkflow } from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { buildBackendWorkflowCompletions } from "./workflow-autocomplete";
import { automaticTriggerSummary, shouldConfirmAutomaticTriggers } from "./workflow-editor-activation";
import {
  type WorkflowEditorDraft,
  workflowEditorDraft,
  workflowEditorDraftDirty,
  workflowEditorSavePayload,
} from "./workflow-editor-draft";
import type { WorkflowStarter } from "./workflow-starters";

type WorkflowEditorApi = {
  "by-base": {
    ":baseId": {
      autocomplete: {
        $post: (
          input: { param: { baseId: string }; json: { source: string; caret: number } },
          options?: { init?: RequestInit },
        ) => Promise<Response>;
      };
      validate: {
        $post: (input: { param: { baseId: string }; json: { source: string } }, options?: { init?: RequestInit }) => Promise<Response>;
      };
      $post: (input: { param: { baseId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
    };
  };
  ":workflowId": {
    $get: (input: { param: { workflowId: string } }) => Promise<Response>;
    $patch: (input: { param: { workflowId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
    $delete: (input: { param: { workflowId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
  };
};

const workflowEditorApi = apiClient.workflows as unknown as WorkflowEditorApi;

type WorkflowEditorProps = {
  baseId: string;
  tables: Array<Pick<PublicTable, "id" | "name">>;
  workflow?: PublicWorkflow;
  starter?: WorkflowStarter;
  beforeClose?: (workflow: PublicWorkflow, context: { abortSignal: AbortSignal }) => Promise<void>;
  onChanged: (workflow?: PublicWorkflow) => void;
  onClose: () => void;
};

class WorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

class WorkflowDiagnosticsError extends Error {}

const workflowHighlight = createWorkflowYamlHighlighter();

const workflowReferenceHref = () => "/app/grids/help/grids-workflows";

const openWorkflowReferenceWindow = () => {
  if (typeof window === "undefined") return;
  window.open(workflowReferenceHref(), "grids-workflow-reference", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
};

const yamlString = (value: string): string => JSON.stringify(value);

const editorDiagnostic = (message: string): WorkflowDiagnostic => ({
  code: "workflow.editor",
  message,
  severity: "error",
  path: [],
});

const defaultSource = (
  table?: Pick<PublicTable, "id" | "name">,
) => `${table ? `inputs:\n  record:\n    type: record\n    table: ${yamlString(table.name)}\n` : ""}steps:
  - setVariable:
      name: ranAt
      value: \${{ now() }}
`;

function DiagnosticsPanel(props: { diagnostics: WorkflowDiagnostic[]; validating: boolean }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const hasDiagnostics = () => props.diagnostics.length > 0;
  return (
    <NoticeCard tone={hasDiagnostics() ? "danger" : "success"} icon={false} role="status" aria-live="polite" aria-busy={props.validating}>
      <div class="flex items-center gap-2 font-medium">
        <i class={`ti ${props.validating ? "ti-loader-2 animate-spin" : hasDiagnostics() ? "ti-alert-triangle" : "ti-circle-check"}`} />
        <span>{props.validating ? t().validating : hasDiagnostics() ? t().yamlHasDiagnostics : t().yamlValid}</span>
      </div>
      <Show when={hasDiagnostics()}>
        <ul class="mt-2 space-y-1">
          <For each={props.diagnostics}>
            {(diagnostic) => (
              <li>
                <Show when={diagnostic.location}>
                  {(location) => (
                    <span class="font-mono text-[11px] uppercase">
                      {t().diagnosticLocation({ line: location().line, column: location().column })}{" "}
                    </span>
                  )}
                </Show>
                {diagnostic.message}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </NoticeCard>
  );
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const blankDraft = workflowEditorDraft(props.workflow, defaultSource(props.tables[0]));
  const initialDraft =
    !props.workflow && props.starter
      ? {
          ...blankDraft,
          name: props.starter.name,
          description: props.starter.description,
          enabled: props.starter.enabled,
          source: props.starter.source,
        }
      : blankDraft;
  let cleanDraft = !props.workflow && props.starter ? blankDraft : initialDraft;
  const [name, setName] = createSignal(initialDraft.name);
  const [persistedName, setPersistedName] = createSignal(initialDraft.name);
  const [description, setDescription] = createSignal(initialDraft.description);
  const [enabled, setEnabled] = createSignal(initialDraft.enabled);
  const [source, setSource] = createSignal(initialDraft.source);
  const [revision, setRevision] = createSignal(initialDraft.revision);
  const [persistedPlan, setPersistedPlan] = createSignal(props.workflow?.plan);
  const [persistedEnabled, setPersistedEnabled] = createSignal(props.workflow?.enabled ?? false);
  const [diagnostics, setDiagnostics] = createSignal<WorkflowDiagnostic[]>([]);
  const [validating, setValidating] = createSignal(false);
  const [confirmingTriggers, setConfirmingTriggers] = createSignal(false);
  let disposed = false;
  let validationTimer: ReturnType<typeof setTimeout> | undefined;
  let validationAbort: AbortController | undefined;

  const currentDraft = (): WorkflowEditorDraft => ({
    name: name(),
    description: description(),
    enabled: enabled(),
    source: source(),
    revision: revision(),
  });
  const fetchAutocomplete = async (request: { source: string; caret: number }, signal: AbortSignal) => {
    const response = await workflowEditorApi["by-base"][":baseId"].autocomplete.$post(
      { param: { baseId: props.baseId }, json: request },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await errorMessage(response, t().loadSuggestionsFailed));
    return (await response.json()) as WorkflowAutocompleteResponse;
  };

  const completions = createMemo(() =>
    buildBackendWorkflowCompletions({
      fetchAutocomplete,
      onDiagnostics: (response) => setDiagnostics(response.diagnostics),
    }),
  );

  const runValidation = async (value: string) => {
    validationAbort?.abort();
    const abort = new AbortController();
    validationAbort = abort;
    if (!value.trim()) {
      setDiagnostics([editorDiagnostic(t().sourceRequired)]);
      setValidating(false);
      return;
    }
    setValidating(true);
    try {
      const response = await fetchAutocomplete({ source: value, caret: value.length }, abort.signal);
      if (!abort.signal.aborted) setDiagnostics(response.diagnostics);
    } catch (error) {
      if (!abort.signal.aborted) {
        setDiagnostics([editorDiagnostic(error instanceof Error ? error.message : t().validateFailed)]);
      }
    } finally {
      if (!abort.signal.aborted) setValidating(false);
    }
  };

  createEffect(() => {
    const current = source();
    if (validationTimer) clearTimeout(validationTimer);
    validationTimer = setTimeout(() => void runValidation(current), 350);
  });

  onCleanup(() => {
    if (validationTimer) clearTimeout(validationTimer);
    validationAbort?.abort();
  });

  const replaceDraft = (draft: WorkflowEditorDraft, plan?: WorkflowBoundPlan) => {
    cleanDraft = draft;
    setName(draft.name);
    setPersistedName(draft.name);
    setDescription(draft.description);
    setEnabled(draft.enabled);
    setSource(draft.source);
    setRevision(draft.revision);
    setPersistedEnabled(draft.enabled);
    if (plan) setPersistedPlan(plan);
  };

  const reloadWorkflow = async () => {
    if (!props.workflow) return;
    const response = await workflowEditorApi[":workflowId"].$get({ param: { workflowId: props.workflow.id } });
    if (!response.ok) throw new Error(await errorMessage(response, t().reloadFailed));
    const latest = PublicGridsWorkflowSchema.parse(await response.json());
    replaceDraft(workflowEditorDraft(latest, defaultSource(props.tables[0])), latest.plan);
    props.onChanged(latest);
    toast.success(t().latestVersionLoaded);
  };

  const handleSaveError = async (error: Error) => {
    if (!(error instanceof WorkflowConflictError)) {
      await prompts.error(error.message);
      return;
    }
    const reload = await prompts.confirm(t().reloadChangedConfirm, {
      title: t().workflowChanged,
      icon: "ti ti-refresh-alert",
      confirmText: t().reloadWorkflow,
    });
    if (!reload) return;
    try {
      await reloadWorkflow();
    } catch (reloadError) {
      await prompts.error(reloadError instanceof Error ? reloadError.message : t().reloadFailed);
    }
  };

  const saveMut = mutations.create<PublicWorkflow, void>({
    mutation: async (_, { abortSignal }) => {
      const draft = currentDraft();
      const payload = workflowEditorSavePayload(draft, cleanDraft, !props.workflow);
      if (!draft.name.trim()) throw new Error(t().nameRequired);
      if (Object.keys(payload).length === 0) throw new Error(t().noChanges);
      const res = props.workflow
        ? await workflowEditorApi[":workflowId"].$patch(
            { param: { workflowId: props.workflow.id }, json: payload },
            { init: { signal: abortSignal, headers: { [WORKFLOW_REVISION_HEADER]: String(revision()) } } },
          )
        : await workflowEditorApi["by-base"][":baseId"].$post(
            { param: { baseId: props.baseId }, json: payload },
            { init: { signal: abortSignal } },
          );
      if (res.status === 409) throw new WorkflowConflictError(t().changedWhileEditing);
      if (!res.ok) throw new Error(await errorMessage(res, t().saveFailed));
      const saved = PublicGridsWorkflowSchema.parse(await res.json());
      if (props.beforeClose) await props.beforeClose(saved, { abortSignal });
      return saved;
    },
    onSuccess: (saved) => {
      if (disposed) return;
      toast.success(t().savedNamed({ name: saved.name }));
      props.onChanged(saved);
      props.onClose();
    },
    onError: (error) => {
      if (!disposed) void handleSaveError(error);
    },
  });

  const triggerValidationMut = mutations.create<
    { plan: WorkflowBoundPlan; source: string; enabled: boolean },
    { source: string; enabled: boolean }
  >({
    mutation: async ({ source, enabled }, { abortSignal }) => {
      const response = await workflowEditorApi["by-base"][":baseId"].validate.$post(
        { param: { baseId: props.baseId }, json: { source } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().validateTriggersFailed));
      const validation = PublicWorkflowValidateResponseSchema.parse(await response.json());
      if (!validation.ok) {
        if (!disposed) setDiagnostics(validation.diagnostics);
        throw new WorkflowDiagnosticsError();
      }
      return { plan: validation.plan, source, enabled };
    },
    onSuccess: async ({ plan, source: validatedSource, enabled: validatedEnabled }) => {
      if (disposed) return;
      setConfirmingTriggers(true);
      try {
        const summary = automaticTriggerSummary(plan, locale());
        const currentPlan = persistedPlan();
        const persistedWorkflow = currentPlan ? { enabled: persistedEnabled(), plan: currentPlan } : undefined;
        if (summary && shouldConfirmAutomaticTriggers(persistedWorkflow, plan, validatedEnabled)) {
          const confirmed = await prompts.confirm(t().activateTriggersConfirm({ summary }), {
            title: t().activateTriggersTitle,
            icon: "ti ti-bolt",
            confirmText: t().activateTriggers,
          });
          if (!confirmed || disposed) return;
        }
        if (disposed) return;
        if (source() !== validatedSource || enabled() !== validatedEnabled) {
          await prompts.error(t().changedDuringValidation);
          return;
        }
        saveMut.mutate();
      } finally {
        setConfirmingTriggers(false);
      }
    },
    onError: (error) => {
      if (!disposed && !(error instanceof WorkflowDiagnosticsError)) void prompts.error(error.message);
    },
  });

  const deleteMut = mutations.create<{ deleted: boolean }, PublicWorkflow>({
    mutation: async (workflow, { abortSignal }) => {
      const confirmed = await prompts.confirm(t().deleteNamedConfirm({ name: persistedName() || workflow.name }), {
        title: t().deleteWorkflow,
        icon: "ti ti-trash",
        confirmText: t().deleteWorkflow,
        variant: "danger",
      });
      if (!confirmed) return { deleted: false };
      const res = await workflowEditorApi[":workflowId"].$delete({ param: { workflowId: workflow.id } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await errorMessage(res, t().deleteFailed));
      return { deleted: true };
    },
    onSuccess: (result) => {
      if (!result.deleted) return;
      toast.success(t().deleted);
      props.onChanged();
      props.onClose();
    },
    onError: (error) => {
      if (!disposed) void prompts.error(error.message);
    },
  });

  onCleanup(() => {
    disposed = true;
    saveMut.abort();
    triggerValidationMut.abort();
    deleteMut.abort();
  });

  const closeIfClean = async () => {
    if (triggerValidationMut.loading() || confirmingTriggers() || saveMut.loading() || deleteMut.loading()) return;
    if (await confirmDiscardIfDirty(() => workflowEditorDraftDirty(currentDraft(), cleanDraft))) props.onClose();
  };

  const canSave = () =>
    workflowEditorDraftDirty(currentDraft(), cleanDraft) &&
    name().trim().length > 0 &&
    source().trim().length > 0 &&
    diagnostics().length === 0 &&
    !validating() &&
    !confirmingTriggers() &&
    !triggerValidationMut.loading() &&
    !saveMut.loading();

  const saveWorkflow = () => {
    if (confirmingTriggers() || triggerValidationMut.loading()) return;
    const sourceToSave = source();
    const enabledToSave = enabled();
    const automaticTriggersMayChange = enabledToSave && (!props.workflow?.enabled || sourceToSave !== cleanDraft.source);
    if (automaticTriggersMayChange) triggerValidationMut.mutate({ source: sourceToSave, enabled: enabledToSave });
    else saveMut.mutate();
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.workflow ? t().manageNamed({ name: persistedName() }) : t().newWorkflow}
        subtitle={t().editorSubtitle}
        icon="ti ti-route"
        close={() => void closeIfClean()}
      />
      <PanelDialog.Body scrollPreserveKey={`grids-workflow-editor-${props.workflow?.id ?? "new"}`}>
        <div class="flex min-h-[34rem] flex-1 flex-col gap-2">
          <div class="grid shrink-0 gap-2 md:grid-cols-2">
            <TextInput label={t().name} value={name} onValueChange={setName} required icon="ti ti-route" placeholder={t().workflowName} />
            <TextInput
              label={t().description}
              value={description}
              onValueChange={setDescription}
              icon="ti ti-align-left"
              placeholder={t().optional}
            />
            <div class="md:col-span-2">
              <CheckboxCard
                label={t().enabled}
                description={t().enabledDescription}
                icon="ti ti-player-play"
                value={enabled}
                onValueChange={setEnabled}
              />
            </div>
          </div>

          <section class="flex min-h-0 flex-1 flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <div>
                <h3 class="text-sm font-semibold text-primary">{t().yamlSource}</h3>
                <p class="text-xs text-dimmed">{t().yamlDescription}</p>
              </div>
              <Button variant="secondary" size="sm" type="button" onClick={openWorkflowReferenceWindow}>
                <i class="ti ti-external-link" /> {t().openReference}
              </Button>
            </div>
            <div class="min-h-[24rem] flex-1">
              <AutocompleteEditor
                value={source}
                onValueChange={setSource}
                completions={completions()}
                highlight={workflowHighlight}
                variant="paper"
                fill
                restoreExpansionOnBackspace={false}
                placeholder={defaultSource(props.tables[0])}
                aria-label={t().yamlAria}
              />
            </div>
            <DiagnosticsPanel diagnostics={diagnostics()} validating={validating()} />
          </section>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div>
          <Show when={props.workflow}>
            {(workflow) => (
              <Button variant="danger" size="sm" type="button" disabled={deleteMut.loading()} onClick={() => deleteMut.mutate(workflow())}>
                <i class={deleteMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} /> {t().deleteWorkflow}
              </Button>
            )}
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={triggerValidationMut.loading() || confirmingTriggers() || saveMut.loading() || deleteMut.loading()}
            onClick={() => void closeIfClean()}
          >
            {t().cancel}
          </Button>
          <Button variant="primary" size="sm" type="button" disabled={!canSave()} onClick={() => void saveWorkflow()}>
            <i class={saveMut.loading() || confirmingTriggers() ? "ti ti-loader-2 animate-spin" : "ti ti-device-floppy"} />{" "}
            {t().saveWorkflow}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
