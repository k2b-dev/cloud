import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  StatusBadge,
  TextInput,
  Tooltip,
} from "@k2b/ui";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicTable } from "../../../api/public-dto";
import { PublicGridsWorkflowLauncherListSchema, PublicGridsWorkflowLauncherSchema } from "../../../api/workflow-public-contracts";
import type { CreateGridsWorkflowLauncherInput, GridsScannerInputSource, GridsWorkflowLauncherKind } from "../../../workflows/contracts";
import { isCanonicalCloseSelectionPlan, isCanonicalCorrectionDraftPlan, scannerLauncherInputSources } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkflow, PublicWorkflowLauncher } from "../workspace/workspace-public-state-model";
import { WorkflowInputFields } from "./WorkflowInputFields";
import { customAppLauncherConfigForSave, missingLauncherRequiredInputs } from "./workflow-launcher-draft";
import {
  buildWorkflowRunInput,
  type WorkflowRunInputDraft,
  type WorkflowRunInputDraftValue,
  workflowInputDraftFromValues,
  workflowInputLabel,
  workflowInputRequired,
} from "./workflow-trigger-actions";

type WorkflowLauncherApi = {
  ":workflowId": {
    launchers: {
      $get: (input: { param: { workflowId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
      $post: (input: { param: { workflowId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
    };
  };
  launchers: {
    ":launcherId": {
      $patch: (input: { param: { launcherId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
      $delete: (input: { param: { launcherId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
    };
  };
};

const workflowLauncherApi = apiClient.workflows as unknown as WorkflowLauncherApi;

type LauncherDraft = CreateGridsWorkflowLauncherInput;

const launcherKindOptions = [
  { id: "scanner", label: "Scanner" },
  { id: "bulk", label: "Bulk selection" },
  { id: "record", label: "Record action" },
  { id: "customApp", label: "App action" },
];

const launcherKindLabel = (kind: GridsWorkflowLauncherKind) => launcherKindOptions.find((option) => option.id === kind)?.label ?? kind;

const launcherConfigurationSummary = (launcher: PublicWorkflowLauncher): string => {
  if (launcher.config.kind === "scanner") {
    const sources = Object.values(scannerLauncherInputSources(launcher.config));
    return `${sources.filter((source) => source.kind === "session").length} before · ${
      sources.filter((source) => source.kind === "afterScan").length
    } after each scan`;
  }
  if (launcher.config.kind === "bulk") {
    return "profile" in launcher.config ? "Exact Close selection" : `Supplies ${launcher.config.input}`;
  }
  if (launcher.config.kind === "record") return "Create correction Draft";
  return launcher.config.inputMode === "prompt" ? "Asks for input when run" : "Uses fixed input values";
};

const defaultDraft = (workflow: PublicWorkflow): LauncherDraft => {
  const recordInput = workflow.plan.inputs.find((input) => input.type === "record")?.name ?? "";
  const textInput = workflow.plan.inputs.find((input) => input.type === "text")?.name ?? "";
  const scanInput = recordInput || textInput;
  return {
    name: "",
    enabled: true,
    config: {
      kind: "scanner",
      inputSources: scanInput
        ? {
            [scanInput]:
              scanInput === recordInput ? { kind: "scan", value: "record", resolve: { by: "scanCode" } } : { kind: "scan", value: "text" },
          }
        : {},
    },
  };
};

type ScannerSourceDraft = "unused" | "scanRecord" | "scanText" | "session" | "afterScan" | "fixed";

const scannerSourceDraft = (source: GridsScannerInputSource | undefined): ScannerSourceDraft => {
  if (!source) return "unused";
  if (source.kind === "scan") return source.value === "record" ? "scanRecord" : "scanText";
  return source.kind;
};

function LauncherEditor(props: {
  workflow: PublicWorkflow;
  tables: PublicTable[];
  launcher?: PublicWorkflowLauncher;
  close: (draft?: LauncherDraft) => void;
}) {
  const initial = props.launcher ?? defaultDraft(props.workflow);
  const [name, setName] = createSignal(initial.name);
  const [enabled, setEnabled] = createSignal(initial.enabled ?? true);
  const [kind, setKind] = createSignal<GridsWorkflowLauncherKind>(initial.config.kind);
  const [input, setInput] = createSignal("input" in initial.config ? initial.config.input : "");
  const initialScannerSources =
    initial.config.kind === "scanner" ? scannerLauncherInputSources(initial.config) : ({} as Record<string, GridsScannerInputSource>);
  const [scannerSources, setScannerSources] = createSignal<Record<string, ScannerSourceDraft>>(
    Object.fromEntries(
      props.workflow.plan.inputs.map((candidate) => [candidate.name, scannerSourceDraft(initialScannerSources[candidate.name])]),
    ),
  );
  const [resolveBy, setResolveBy] = createSignal<"scanCode" | "field">(
    initial.config.kind === "scanner"
      ? (Object.values(initialScannerSources).find(
          (source): source is Extract<GridsScannerInputSource, { kind: "scan"; value: "record" }> =>
            source.kind === "scan" && source.value === "record",
        )?.resolve.by ?? "scanCode")
      : "scanCode",
  );
  const [field, setField] = createSignal(
    initial.config.kind === "scanner"
      ? (Object.values(initialScannerSources).find(
          (source): source is Extract<GridsScannerInputSource, { kind: "scan"; value: "record" }> =>
            source.kind === "scan" && source.value === "record" && source.resolve.by === "field",
        )?.resolve.field ?? "")
      : "",
  );
  const [scannerFixedDraft, setScannerFixedDraft] = createSignal<WorkflowRunInputDraft>(
    workflowInputDraftFromValues(
      props.workflow.plan.inputs,
      Object.fromEntries(
        Object.entries(initialScannerSources)
          .filter(([, source]) => source.kind === "fixed")
          .map(([name, source]) => [name, source.kind === "fixed" ? source.value : null]),
      ),
    ),
  );
  const [customAppInputMode, setCustomAppInputMode] = createSignal<"fixed" | "prompt">(
    initial.config.kind === "customApp" ? initial.config.inputMode : "fixed",
  );
  const [customAppBindings, setCustomAppBindings] = createSignal<WorkflowRunInputDraft>(
    workflowInputDraftFromValues(
      props.workflow.plan.inputs,
      initial.config.kind === "customApp" ? initial.config.inputBindings : undefined,
    ),
  );
  const inputOptions = createMemo(() =>
    props.workflow.plan.inputs
      .filter((candidate) => candidate.type === (kind() === "record" ? "record" : "recordList"))
      .map((candidate) => ({ id: candidate.name, label: candidate.config.label?.toString() || candidate.name })),
  );
  const closeSelectionProfile = createMemo(() => (kind() === "bulk" ? isCanonicalCloseSelectionPlan(props.workflow.plan, input()) : false));
  const correctionDraftProfile = createMemo(() =>
    kind() === "record" ? isCanonicalCorrectionDraftPlan(props.workflow.plan, input()) : false,
  );
  const missingRequiredInputs = createMemo(() => missingLauncherRequiredInputs(props.workflow.plan.inputs, kind(), input()));
  const customAppValidation = createMemo(() => buildWorkflowRunInput(props.workflow.plan.inputs, customAppBindings()));
  const fixedScannerInputs = createMemo(() =>
    props.workflow.plan.inputs.filter((candidate) => scannerSources()[candidate.name] === "fixed"),
  );
  const scannerFixedValidation = createMemo(() => buildWorkflowRunInput(fixedScannerInputs(), scannerFixedDraft()));
  const scannerScanCount = createMemo(
    () => Object.values(scannerSources()).filter((source) => source === "scanRecord" || source === "scanText").length,
  );
  const missingScannerInputs = createMemo(() =>
    props.workflow.plan.inputs
      .filter((candidate) => workflowInputRequired(candidate) && scannerSources()[candidate.name] === "unused")
      .map(workflowInputLabel),
  );
  const fixedScannerValuesComplete = createMemo(() => {
    const validation = scannerFixedValidation();
    return validation.ok && fixedScannerInputs().every((candidate) => Object.hasOwn(validation.input, candidate.name));
  });
  const valid = createMemo(
    () =>
      name().trim().length > 0 &&
      (kind() === "customApp"
        ? customAppInputMode() === "prompt" || customAppValidation().ok
        : kind() === "scanner"
          ? scannerScanCount() === 1 &&
            missingScannerInputs().length === 0 &&
            fixedScannerValuesComplete() &&
            (Object.values(scannerSources()).includes("scanRecord") ? resolveBy() !== "field" || field().trim().length > 0 : true)
          : kind() === "record"
            ? input().length > 0 && correctionDraftProfile()
            : input().length > 0 && (closeSelectionProfile() || missingRequiredInputs().length === 0)),
  );
  const customAppErrors = () => {
    const validation = customAppValidation();
    return validation.ok ? {} : validation.errors;
  };
  const setCustomAppBinding = (name: string, value: WorkflowRunInputDraftValue) =>
    setCustomAppBindings((current) => ({ ...current, [name]: value }));
  const setScannerFixedValue = (name: string, value: WorkflowRunInputDraftValue) =>
    setScannerFixedDraft((current) => ({ ...current, [name]: value }));

  const submit = () => {
    if (!valid()) return;
    const bindings = customAppValidation();
    const fixedScannerValues = scannerFixedValidation();
    const scannerInputSources = (): Record<string, GridsScannerInputSource> => {
      const entries: Array<[string, GridsScannerInputSource]> = [];
      for (const candidate of props.workflow.plan.inputs) {
        const source = scannerSources()[candidate.name] ?? "unused";
        if (source === "unused") continue;
        if (source === "scanRecord") {
          entries.push([
            candidate.name,
            {
              kind: "scan",
              value: "record",
              resolve: resolveBy() === "field" ? { by: "field", field: field().trim() } : { by: "scanCode" },
            },
          ]);
        } else if (source === "scanText") {
          entries.push([candidate.name, { kind: "scan", value: "text" }]);
        } else if (source === "fixed" && fixedScannerValues.ok) {
          entries.push([candidate.name, { kind: "fixed", value: fixedScannerValues.input[candidate.name]! }]);
        } else if (source === "session" || source === "afterScan") {
          entries.push([candidate.name, { kind: source }]);
        }
      }
      return Object.fromEntries(entries);
    };
    const config: LauncherDraft["config"] =
      kind() === "customApp"
        ? customAppLauncherConfigForSave(
            props.launcher,
            customAppInputMode(),
            customAppInputMode() === "fixed" && bindings.ok ? bindings.input : undefined,
          )
        : kind() === "bulk"
          ? {
              kind: "bulk",
              input: input(),
              ...(closeSelectionProfile() ? { profile: "closeSelection" as const } : {}),
            }
          : kind() === "record"
            ? { kind: "record", input: input(), profile: "correctionDraft" }
            : { kind: "scanner", inputSources: scannerInputSources() };
    props.close({ name: name().trim(), enabled: enabled(), config });
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.launcher ? "Edit run option" : "Add run option"}
        subtitle={props.workflow.name}
        icon="ti ti-rocket"
        close={() => props.close()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-3">
          <TextInput label="Name" required value={name} onValueChange={setName} icon="ti ti-letter-case" />
          <Select
            label="Surface"
            required
            options={launcherKindOptions}
            value={() => kind()}
            onValueChange={(value) => {
              const next = value as GridsWorkflowLauncherKind;
              setKind(next);
              if (next !== "customApp") {
                setInput(
                  props.workflow.plan.inputs.find(
                    (candidate) => candidate.type === (next === "scanner" || next === "record" ? "record" : "recordList"),
                  )?.name ?? "",
                );
              }
            }}
          />
          <Show when={kind() === "bulk" || kind() === "record"}>
            <Select
              label={kind() === "record" ? "Record input" : "Record-list input"}
              description="The run option supplies this workflow input."
              required
              options={inputOptions()}
              value={input}
              onValueChange={setInput}
            />
            <Show when={closeSelectionProfile()}>
              <NoticeCard tone="info" icon="ti ti-list-check">
                This run option closes only the exact Records a person selects and confirms.
              </NoticeCard>
            </Show>
            <Show when={correctionDraftProfile()}>
              <NoticeCard tone="info" icon="ti ti-file-pencil">
                This action creates one correction Draft from the finalized Record a person opens.
              </NoticeCard>
            </Show>
            <Show when={!closeSelectionProfile() && !correctionDraftProfile() && missingRequiredInputs().length > 0}>
              <NoticeCard tone="danger" icon={false} role="alert">
                This surface cannot supply the required {missingRequiredInputs().length === 1 ? "input" : "inputs"}:{" "}
                {missingRequiredInputs().join(", ")}. Use a App run option or make the inputs optional.
              </NoticeCard>
            </Show>
          </Show>
          <Show when={kind() === "scanner"}>
            <div class="flex flex-col gap-3">
              <p class="text-sm text-dimmed">
                Choose where each workflow input comes from. Input names are workflow-defined and have no special meaning.
              </p>
              <For each={props.workflow.plan.inputs}>
                {(candidate) => (
                  <Select
                    label={workflowInputLabel(candidate)}
                    description={`${candidate.type}${workflowInputRequired(candidate) ? " · required" : ""}`}
                    required={workflowInputRequired(candidate)}
                    options={[
                      { id: "unused", label: "Not supplied" },
                      ...(candidate.type === "record" ? [{ id: "scanRecord", label: "Scanned record" }] : []),
                      ...(candidate.type === "text" ? [{ id: "scanText", label: "Scanned text" }] : []),
                      { id: "session", label: "Ask before scanning" },
                      { id: "afterScan", label: "Ask after every scan" },
                      { id: "fixed", label: "Fixed value" },
                    ]}
                    value={() => scannerSources()[candidate.name] ?? "unused"}
                    onValueChange={(value) =>
                      setScannerSources((current) => ({ ...current, [candidate.name]: value as ScannerSourceDraft }))
                    }
                  />
                )}
              </For>
              <Show when={scannerScanCount() !== 1}>
                <NoticeCard tone="danger" icon={false} role="alert">
                  Choose exactly one workflow input as the scanned value.
                </NoticeCard>
              </Show>
              <Show when={missingScannerInputs().length > 0}>
                <NoticeCard tone="danger" icon={false} role="alert">
                  Choose a source for the required {missingScannerInputs().length === 1 ? "input" : "inputs"}:{" "}
                  {missingScannerInputs().join(", ")}.
                </NoticeCard>
              </Show>
              <Show when={fixedScannerInputs().length > 0}>
                <WorkflowInputFields
                  workflow={{
                    plan: { inputs: fixedScannerInputs(), bindings: props.workflow.plan.bindings },
                  }}
                  tables={props.tables}
                  draft={scannerFixedDraft}
                  onValueChange={setScannerFixedValue}
                  errors={() => {
                    const result = scannerFixedValidation();
                    return result.ok ? {} : result.errors;
                  }}
                />
              </Show>
            </div>
          </Show>
          <Show when={kind() === "customApp"}>
            <Select
              label="Inputs"
              description="Use fixed values for a one-click action, or ask the user when the button runs."
              required
              options={[
                { id: "fixed", label: "Fixed values" },
                { id: "prompt", label: "Ask when run" },
              ]}
              value={customAppInputMode}
              onValueChange={(value) => setCustomAppInputMode(value as "fixed" | "prompt")}
            />
            <Show when={customAppInputMode() === "fixed"}>
              <WorkflowInputFields
                workflow={props.workflow}
                tables={props.tables}
                draft={customAppBindings}
                onValueChange={setCustomAppBinding}
                errors={customAppErrors}
                emptyText="This workflow does not need input."
              />
              <Show when={!customAppValidation().ok}>
                <NoticeCard tone="danger" icon={false} role="alert">
                  Provide valid fixed values for every required workflow input.
                </NoticeCard>
              </Show>
            </Show>
          </Show>
          <Show when={kind() === "scanner" && Object.values(scannerSources()).includes("scanRecord")}>
            <Select
              label="Resolve scanned values by"
              required
              options={[
                { id: "scanCode", label: "Generated scan code" },
                { id: "field", label: "Unique field" },
              ]}
              value={resolveBy}
              onValueChange={(value) => setResolveBy(value as "scanCode" | "field")}
            />
            <Show when={resolveBy() === "field"}>
              <TextInput
                label="Unique field"
                description="Use a field name, short ID, or UUID from the bound table."
                required
                value={field}
                onValueChange={setField}
                icon="ti ti-columns"
              />
            </Show>
          </Show>
          <CheckboxCard
            label="Enabled"
            description="Enabled run options are available on their scanner, table, or App surface."
            value={enabled}
            onValueChange={setEnabled}
          />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => props.close()}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" disabled={!valid()} onClick={submit}>
            <i class="ti ti-check" /> {props.launcher ? "Save run option" : "Add run option"}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

const requestLauncherDraft = (workflow: PublicWorkflow, tables: PublicTable[], launcher?: PublicWorkflowLauncher) =>
  dialogCore.open<LauncherDraft>(
    (close) => <LauncherEditor workflow={workflow} tables={tables} launcher={launcher} close={close} />,
    panelDialogOptions,
  );

export function WorkflowLauncherManager(props: {
  workflow: PublicWorkflow;
  tables: PublicTable[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [launchers, setLaunchers] = createSignal<PublicWorkflowLauncher[]>([]);
  const [loaded, setLoaded] = createSignal(false);

  const loadMut = mutations.create<void, void>({
    onBefore: () => setLoaded(false),
    mutation: async (_, { abortSignal }) => {
      const res = await workflowLauncherApi[":workflowId"].launchers.$get(
        { param: { workflowId: props.workflow.id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load run options."));
      setLaunchers(PublicGridsWorkflowLauncherListSchema.parse(await res.json()).items);
    },
    onSuccess: () => setLoaded(true),
  });

  const saveMut = mutations.create<PublicWorkflowLauncher, { launcher?: PublicWorkflowLauncher; draft: LauncherDraft }>({
    mutation: async ({ launcher, draft }, { abortSignal }) => {
      const res = launcher
        ? await workflowLauncherApi.launchers[":launcherId"].$patch(
            { param: { launcherId: launcher.id }, json: draft },
            { init: { signal: abortSignal } },
          )
        : await workflowLauncherApi[":workflowId"].launchers.$post(
            { param: { workflowId: props.workflow.id }, json: draft },
            { init: { signal: abortSignal } },
          );
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save run option."));
      return PublicGridsWorkflowLauncherSchema.parse(await res.json());
    },
    onSuccess: () => {
      loadMut.mutate();
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const removeMut = mutations.create<boolean, PublicWorkflowLauncher>({
    mutation: async (launcher, { abortSignal }) => {
      const confirmed = await prompts.confirm(`Delete run option "${launcher.name}"?`, {
        title: "Delete run option?",
        variant: "danger",
        confirmText: "Delete",
      });
      if (!confirmed) return false;
      const res = await workflowLauncherApi.launchers[":launcherId"].$delete(
        { param: { launcherId: launcher.id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, "Could not delete run option."));
      return true;
    },
    onSuccess: (deleted) => {
      if (!deleted) return;
      loadMut.mutate();
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const edit = async (launcher?: PublicWorkflowLauncher) => {
    if (!loaded() || loadMut.loading() || saveMut.loading() || removeMut.loading()) return;
    const draft = await requestLauncherDraft(props.workflow, props.tables, launcher);
    if (draft) saveMut.mutate({ launcher, draft });
  };

  const mutationsBlocked = () => !loaded() || loadMut.loading() || saveMut.loading() || removeMut.loading();

  onMount(() => loadMut.mutate());

  return (
    <PanelDialog>
      <PanelDialog.Header title="Run options" subtitle={props.workflow.name} icon="ti ti-rocket" close={props.onClose} />
      <PanelDialog.Body>
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <p class="text-sm text-dimmed">Make this workflow available as a scanner, Record action, bulk action, or App action.</p>
            <Button variant="primary" size="sm" type="button" disabled={mutationsBlocked()} onClick={() => void edit()}>
              <i class="ti ti-plus" /> Add run option
            </Button>
          </div>
          <Show
            when={!loadMut.error()}
            fallback={
              <Placeholder
                state="error"
                surface="paper"
                align="left"
                title="Could not load run options"
                description={loadMut.error()?.message}
                action={
                  <Button variant="secondary" size="sm" type="button" disabled={loadMut.loading()} onClick={() => loadMut.retry()}>
                    <i class="ti ti-refresh" aria-hidden="true" /> Retry
                  </Button>
                }
              />
            }
          >
            <Show when={loaded()} fallback={<Placeholder state="loading" align="left" description="Loading run options..." />}>
              <For each={launchers()} fallback={<Placeholder align="left" description={<>No run options configured.</>} />}>
                {(launcher) => {
                  const stale = () => launcher.validatedRevision !== props.workflow.revision;
                  const invalid = () => launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error");
                  return (
                    <div class="paper flex items-start gap-3 px-3 py-2">
                      <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                        <i
                          class={`ti ${launcher.config.kind === "scanner" ? "ti-barcode" : launcher.config.kind === "bulk" ? "ti-list-check" : launcher.config.kind === "record" ? "ti-file-pencil" : "ti-app-window"}`}
                        />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate text-sm font-medium text-primary">{launcher.name}</span>
                          <StatusBadge
                            tone={launcher.enabled && !stale() && !invalid() ? "ok" : "neutral"}
                            label={launcher.enabled && !stale() && !invalid() ? "available" : "unavailable"}
                          />
                        </span>
                        <span class="mt-0.5 block text-xs text-dimmed">
                          {launcherKindLabel(launcher.config.kind)} · {launcherConfigurationSummary(launcher)}
                        </span>
                        <Show when={stale()}>
                          <span class="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                            Workflow changed. Review and save this run option before enabling it.
                          </span>
                        </Show>
                        <For each={launcher.diagnostics}>
                          {(diagnostic) => <span class="mt-1 block text-xs text-red-600 dark:text-red-400">{diagnostic.message}</span>}
                        </For>
                      </span>
                      <Tooltip.Anchor content="Edit run option">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          disabled={mutationsBlocked()}
                          label={`Edit ${launcher.name}`}
                          onClick={() => void edit(launcher)}
                        >
                          <i class="ti ti-pencil" />
                        </IconButton>
                      </Tooltip.Anchor>
                      <Tooltip.Anchor content="Delete run option">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          class="text-red-600 dark:text-red-400"
                          disabled={mutationsBlocked()}
                          label={`Delete ${launcher.name}`}
                          onClick={() => removeMut.mutate(launcher)}
                        >
                          <i class="ti ti-trash" />
                        </IconButton>
                      </Tooltip.Anchor>
                    </div>
                  );
                }}
              </For>
            </Show>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button variant="secondary" size="sm" type="button" onClick={props.onClose}>
          Done
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
