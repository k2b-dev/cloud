import { mutation as mutations, query, timed } from "@k2b/stdlib/solid";
import {
  AutocompleteEditor,
  Button,
  ButtonLink,
  CodeDisplay,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  prompts,
  StatusBadge,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import {
  buildWorkflowAutocompleteCompletions,
  createWorkflowYamlHighlighter,
  type WorkflowAutocompleteRequest,
} from "@valentinkolb/cloud/workflows/editor";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  MailWorkflow,
  MailWorkflowDetail,
  MailWorkflowVersion,
  WorkflowAutocomplete,
  WorkflowEffectBudget,
  WorkflowValidation,
} from "../../contracts";
import type { ConversationReferenceConfiguration } from "../../service/conversation-reference";
import { readApiError } from "./api-response";
import { MailReferenceConfigurationForm } from "./MailResponsePolicySettings";
import { waitForMailPageTransition } from "./mail-page-transition";
import { mailRemainingMessages } from "./mail-remaining-messages";

const DEFAULT_BUDGET: WorkflowEffectBudget = {
  maxTargets: 1_000,
  maxMoves: 1_000,
  maxCopies: 1_000,
  maxSends: 1_000,
  maxDrafts: 1_000,
  maxFlagChanges: 2_000,
  maxNotifications: 1_000,
  maxKeywordChanges: 2_000,
  maxCollaborationChanges: 2_000,
  maxAiCalls: 10,
};

const STARTER_SOURCE = `inputs:
  message:
    type: mailMessage
    required: true
steps:
  - addKeyword:
      message: "\${{ inputs.message }}"
      keyword: Review
`;
const workflowHighlight = createWorkflowYamlHighlighter();
const WORKFLOW_REFERENCE_HREF = "/app/mail/help/mail-workflows";

const asSummary = (workflow: MailWorkflowDetail): MailWorkflow => ({
  id: workflow.id,
  mailboxId: workflow.mailboxId,
  name: workflow.name,
  description: workflow.description,
  priority: workflow.priority,
  currentVersionId: workflow.currentVersionId,
  activeVersionId: workflow.activeVersionId,
  enabled: workflow.enabled,
  createdAt: workflow.createdAt,
  updatedAt: workflow.updatedAt,
});

function WorkflowEditor(props: {
  mailboxId: string;
  workflow: MailWorkflowDetail | null;
  referenceConfiguration: ConversationReferenceConfiguration | null;
  onReferenceConfigurationChange: (configuration: ConversationReferenceConfiguration) => void;
  close: () => void;
  onSaved: (workflow: MailWorkflowDetail) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const [name, setName] = createSignal(props.workflow?.name ?? "");
  const [description, setDescription] = createSignal(props.workflow?.description ?? "");
  const [priority, setPriority] = createSignal(props.workflow?.priority ?? 100);
  const [source, setSource] = createSignal(props.workflow?.currentVersion.source ?? STARTER_SOURCE);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = createSignal(props.workflow?.updatedAt ?? "");
  const initialBudget = props.workflow?.currentVersion.effectBudget ?? DEFAULT_BUDGET;
  const [maxTargets, setMaxTargets] = createSignal(initialBudget.maxTargets);
  const [maxMoves, setMaxMoves] = createSignal(initialBudget.maxMoves);
  const [maxCopies, setMaxCopies] = createSignal(initialBudget.maxCopies ?? DEFAULT_BUDGET.maxCopies ?? 1_000);
  const [maxSends, setMaxSends] = createSignal(initialBudget.maxSends ?? DEFAULT_BUDGET.maxSends ?? 1_000);
  const [maxDrafts, setMaxDrafts] = createSignal(initialBudget.maxDrafts ?? DEFAULT_BUDGET.maxDrafts ?? 1_000);
  const [maxFlagChanges, setMaxFlagChanges] = createSignal(initialBudget.maxFlagChanges ?? DEFAULT_BUDGET.maxFlagChanges ?? 2_000);
  const [maxNotifications, setMaxNotifications] = createSignal(initialBudget.maxNotifications ?? DEFAULT_BUDGET.maxNotifications ?? 1_000);
  const [maxKeywordChanges, setMaxKeywordChanges] = createSignal(initialBudget.maxKeywordChanges);
  const [maxCollaborationChanges, setMaxCollaborationChanges] = createSignal(initialBudget.maxCollaborationChanges);
  const [maxAiCalls, setMaxAiCalls] = createSignal(initialBudget.maxAiCalls);
  const [validation, setValidation] = createSignal<WorkflowValidation | null>(null);
  const [referenceConfiguration, setReferenceConfiguration] = createSignal(props.referenceConfiguration);
  const [validationSource, setValidationSource] = createSignal(source());

  const budget = (): WorkflowEffectBudget => ({
    maxTargets: maxTargets(),
    maxMoves: maxMoves(),
    maxCopies: maxCopies(),
    maxSends: maxSends(),
    maxDrafts: maxDrafts(),
    maxFlagChanges: maxFlagChanges(),
    maxNotifications: maxNotifications(),
    maxKeywordChanges: maxKeywordChanges(),
    maxCollaborationChanges: maxCollaborationChanges(),
    maxAiCalls: maxAiCalls(),
  });

  const fetchAutocomplete = async (request: WorkflowAutocompleteRequest, signal: AbortSignal): Promise<WorkflowAutocomplete> => {
    const response = await apiClient.mailboxes[":mailboxId"].workflows.autocomplete.$post(
      {
        param: { mailboxId: props.mailboxId },
        json: request,
      },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, messages().workflowSuggestionsFailed));
    const result = await response.json();
    if (!signal.aborted && request.source === source()) {
      setValidation({
        valid: !result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        source: request.source,
        sourceHash: null,
        ir: null,
        boundPlan: null,
        diagnostics: result.diagnostics,
      });
    }
    return result;
  };
  const completions = buildWorkflowAutocompleteCompletions({ fetchAutocomplete });

  const validationQuery = query.create<string, WorkflowValidation>({
    source: validationSource,
    load: async (requestedSource, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].workflows.validate.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: { source: requestedSource },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().workflowValidationFailed));
      return response.json();
    },
  });
  const validationDebounce = timed.debounce(setValidationSource, 350);
  const validating = () => validationQuery.loading() || validationQuery.refreshing() || validationDebounce.isPending();

  createEffect(() => {
    const current = source();
    validationDebounce.debouncedFn(current);
  });
  createEffect(() => {
    const result = validationQuery.data();
    if (result?.source === source()) setValidation(result);
  });

  const runValidation = async (announce: boolean) => {
    validationDebounce.trigger(source());
    await Promise.resolve();
    try {
      await validationQuery.invalidate();
      const result = validationQuery.data();
      if (announce && result?.valid) toast.success(messages().workflowValid);
    } catch (error) {
      if (announce) await prompts.error(error instanceof Error ? error.message : messages().workflowValidationFailed);
    }
  };

  const updateDetails = mutations.create<MailWorkflowDetail, void>({
    mutation: async (_input, { abortSignal }) => {
      const workflow = props.workflow;
      if (!workflow) throw new Error(messages().saveWorkflowBeforeDetails);
      const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].$patch(
        {
          param: { mailboxId: props.mailboxId, workflowId: workflow.id },
          json: {
            expectedUpdatedAt: expectedUpdatedAt(),
            name: name().trim(),
            description: description().trim() || null,
            priority: priority(),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateWorkflowDetails));
      return await response.json();
    },
    onSuccess: (workflow) => {
      setExpectedUpdatedAt(workflow.updatedAt);
      props.onSaved(workflow);
      toast.success(messages().workflowDetailsUpdated);
    },
    onError: (error) => prompts.error(error.message),
  });

  const save = mutations.create<MailWorkflowDetail, void>({
    mutation: async (_input, { abortSignal }) => {
      const existing = props.workflow;
      const response = existing
        ? await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].versions.$post(
            {
              param: { mailboxId: props.mailboxId, workflowId: existing.id },
              json: { source: source(), effectBudget: budget() },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"].workflows.$post(
            {
              param: { mailboxId: props.mailboxId },
              json: {
                name: name().trim(),
                description: description().trim() || null,
                priority: priority(),
                source: source(),
                effectBudget: budget(),
              },
            },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveWorkflow));
      return await response.json();
    },
    onSuccess: (workflow) => {
      toast.success(props.workflow ? messages().workflowVersionSaved : messages().workflowCreated);
      props.onSaved(workflow);
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    updateDetails.abort();
    save.abort();
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.workflow ? name() : messages().newWorkflow}
        subtitle={messages().workflowEditorDescription}
        icon="ti ti-route"
        close={props.close}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().identity} subtitle={messages().shownToMailboxAdmins} icon="ti ti-id">
          <TextInput label={messages().name} value={name} onValueChange={setName} required />
          <TextInput label={messages().description} value={description} onValueChange={setDescription} multiline lines={2} />
          <NumberInput
            label={messages().priority}
            value={priority}
            onValueChange={(value) => setPriority(value ?? 100)}
            min={-1_000}
            max={1_000}
          />
          <Show when={props.workflow}>
            <div class="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={updateDetails.loading() || !name().trim()}
                onClick={() => updateDetails.mutate()}
              >
                <i class={`ti ${updateDetails.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
                {messages().updateDetails}
              </Button>
            </div>
          </Show>
        </PanelDialog.Section>
        <PanelDialog.Section
          title={messages().conversationReferences}
          subtitle={messages().conversationReferencesDescription}
          icon="ti ti-hash"
        >
          <Show
            when={referenceConfiguration()?.enabled}
            fallback={
              <MailReferenceConfigurationForm
                mailboxId={props.mailboxId}
                configuration={referenceConfiguration()}
                compact
                onSaved={(configuration) => {
                  setReferenceConfiguration(configuration);
                  props.onReferenceConfigurationChange(configuration);
                }}
              />
            }
          >
            <NoticeCard tone="success" icon={false} bodyClass="flex items-start gap-2">
              <i class="ti ti-check mt-0.5 shrink-0" aria-hidden="true" />
              <span>{messages().referenceNumbersReady({ pattern: referenceConfiguration()!.pattern })}</span>
            </NoticeCard>
          </Show>
        </PanelDialog.Section>
        <PanelDialog.Section title={messages().workflowYaml} subtitle={messages().workflowYamlDescription} icon="ti ti-code">
          <div class="flex justify-end">
            <ButtonLink variant="ghost" size="sm" href={WORKFLOW_REFERENCE_HREF} target="_blank" rel="noreferrer">
              <i class="ti ti-external-link" aria-hidden="true" /> {messages().openYamlReference}
            </ButtonLink>
          </div>
          <div class="min-h-[24rem]">
            <AutocompleteEditor
              aria-label={messages().workflowYaml}
              value={source}
              onValueChange={(value) => {
                setSource(value);
                setValidation(null);
              }}
              completions={completions}
              highlight={workflowHighlight}
              variant="paper"
              fill
              restoreExpansionOnBackspace={false}
              lines={24}
              spellcheck={false}
            />
          </div>
          <Show when={validation()}>
            {(result) => (
              <NoticeCard tone={result().valid ? "success" : "danger"} icon={false} role="status">
                <p class="text-sm font-medium">
                  {validating() ? messages().validating : result().valid ? messages().yamlValid : messages().fixValidationErrors}
                </p>
                <For each={result().diagnostics}>
                  {(diagnostic) => (
                    <p class="mt-1 font-mono text-xs">
                      {diagnostic.location
                        ? messages().diagnosticLocation({ line: diagnostic.location.line, column: diagnostic.location.column })
                        : ""}
                      {diagnostic.message}
                    </p>
                  )}
                </For>
              </NoticeCard>
            )}
          </Show>
        </PanelDialog.Section>
        <PanelDialog.Section title={messages().effectBudget} subtitle={messages().effectBudgetDescription} icon="ti ti-gauge">
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <NumberInput
              label={messages().targets}
              value={maxTargets}
              onValueChange={(value) => setMaxTargets(value ?? 1)}
              min={1}
              max={50_000}
            />
            <NumberInput
              label={messages().moves}
              value={maxMoves}
              onValueChange={(value) => setMaxMoves(value ?? 0)}
              min={0}
              max={50_000}
            />
            <NumberInput
              label={messages().copies}
              value={maxCopies}
              onValueChange={(value) => setMaxCopies(value ?? 0)}
              min={0}
              max={50_000}
            />
            <NumberInput
              label={messages().sends}
              value={maxSends}
              onValueChange={(value) => setMaxSends(value ?? 0)}
              min={0}
              max={50_000}
            />
            <NumberInput
              label={messages().drafts}
              value={maxDrafts}
              onValueChange={(value) => setMaxDrafts(value ?? 0)}
              min={0}
              max={50_000}
            />
            <NumberInput
              label={messages().flagChanges}
              value={maxFlagChanges}
              onValueChange={(value) => setMaxFlagChanges(value ?? 0)}
              min={0}
              max={100_000}
            />
            <NumberInput
              label={messages().notifications}
              value={maxNotifications}
              onValueChange={(value) => setMaxNotifications(value ?? 0)}
              min={0}
              max={50_000}
            />
            <NumberInput
              label={messages().keywordChanges}
              value={maxKeywordChanges}
              onValueChange={(value) => setMaxKeywordChanges(value ?? 0)}
              min={0}
              max={100_000}
            />
            <NumberInput
              label={messages().collaborationChanges}
              value={maxCollaborationChanges}
              onValueChange={(value) => setMaxCollaborationChanges(value ?? 0)}
              min={0}
              max={100_000}
            />
            <NumberInput
              label={messages().aiCalls}
              value={maxAiCalls}
              onValueChange={(value) => setMaxAiCalls(value ?? 0)}
              min={0}
              max={1_000}
            />
          </div>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" type="button" disabled={validating()} onClick={() => void runValidation(true)}>
          <i class={`ti ${validating() ? "ti-loader-2 animate-spin" : "ti-shield-check"}`} aria-hidden="true" /> {messages().validate}
        </Button>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={props.close}>
            {messages().cancel}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={save.loading() || !source().trim() || (!props.workflow && !name().trim())}
            onClick={() => save.mutate()}
          >
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
            {props.workflow ? messages().saveVersion : messages().createWorkflow}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function WorkflowVersionViewer(props: {
  workflow: MailWorkflow;
  version: MailWorkflowVersion;
  close: () => void;
  restoring: boolean;
  restore: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.version.identity}
        subtitle={messages().immutableSource({ hash: props.version.sourceHash })}
        icon="ti ti-history"
        close={props.close}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().exactYamlSource} subtitle={messages().exactYamlSourceDescription} icon="ti ti-code">
          <CodeDisplay code={props.version.source} language="text" title={props.version.identity} />
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="flex items-center gap-2">
          <Show when={props.version.id === props.workflow.activeVersionId}>
            <StatusBadge tone="ok" label={messages().active} />
          </Show>
          <Show when={props.version.id === props.workflow.currentVersionId}>
            <StatusBadge tone="neutral" label={messages().current} icon={null} />
          </Show>
        </span>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={props.close}>
            {messages().close}
          </Button>
          <Show when={props.version.id !== props.workflow.currentVersionId}>
            <Button size="sm" type="button" disabled={props.restoring} onClick={props.restore}>
              <i class={`ti ${props.restoring ? "ti-loader-2 animate-spin" : "ti-history"}`} aria-hidden="true" />
              {messages().restoreAsNewVersion}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function MailWorkflowSettings(props: {
  mailboxId: string;
  initialWorkflows: MailWorkflow[];
  referenceConfiguration: ConversationReferenceConfiguration | null;
  onReferenceConfigurationChange: (configuration: ConversationReferenceConfiguration) => void;
  onWorkflowsChange?: (workflows: MailWorkflow[]) => void;
  openNew?: boolean;
  onOpenNewHandled?: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  let disposed = false;
  const [workflows, setWorkflows] = createSignal(props.initialWorkflows);
  const [versions, setVersions] = createSignal<Record<string, MailWorkflowVersion[]>>({});
  const [expandedWorkflowId, setExpandedWorkflowId] = createSignal<string | null>(null);

  const replaceWorkflow = (workflow: MailWorkflowDetail) => {
    setVersions((current) => {
      if (!current[workflow.id]) return current;
      const next = { ...current };
      delete next[workflow.id];
      return next;
    });
    const next = (() => {
      const current = workflows();
      const summary = asSummary(workflow);
      return current.some((item) => item.id === workflow.id)
        ? current.map((item) => (item.id === workflow.id ? summary : item))
        : [...current, summary];
    })();
    setWorkflows(next);
    props.onWorkflowsChange?.(next);
  };

  const openEditor = async (workflow?: MailWorkflow) => {
    let detail: MailWorkflowDetail | null = null;
    if (workflow) {
      const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].$get({
        param: { mailboxId: props.mailboxId, workflowId: workflow.id },
      });
      if (!response.ok) return await prompts.error(await readApiError(response, messages().failedLoadWorkflow));
      detail = await response.json();
    }
    await dialogCore.open<void>(
      (close) => (
        <WorkflowEditor
          mailboxId={props.mailboxId}
          workflow={detail}
          referenceConfiguration={props.referenceConfiguration}
          onReferenceConfigurationChange={props.onReferenceConfigurationChange}
          close={() => close()}
          onSaved={replaceWorkflow}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };
  let openedInitialEditor = false;
  createEffect(() => {
    if (!props.openNew || openedInitialEditor) return;
    openedInitialEditor = true;
    void (async () => {
      await waitForMailPageTransition();
      if (disposed) return;
      props.onOpenNewHandled?.();
      await openEditor();
    })();
  });

  const activate = mutations.create<MailWorkflowDetail, MailWorkflow>({
    mutation: async (workflow, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].activate.$post(
        {
          param: { mailboxId: props.mailboxId, workflowId: workflow.id },
          json: { expectedVersionId: workflow.currentVersionId },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedActivateWorkflow));
      return await response.json();
    },
    onSuccess: (workflow) => {
      replaceWorkflow(workflow);
      toast.success(messages().workflowActivated);
    },
    onError: (error) => prompts.error(error.message),
  });

  const deactivate = mutations.create<MailWorkflowDetail, MailWorkflow>({
    mutation: async (workflow, { abortSignal }) => {
      if (!workflow.activeVersionId) throw new Error(messages().workflowNotActive);
      const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].deactivate.$post(
        {
          param: { mailboxId: props.mailboxId, workflowId: workflow.id },
          json: { expectedVersionId: workflow.activeVersionId },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedDeactivateWorkflow));
      return await response.json();
    },
    onSuccess: (workflow) => {
      replaceWorkflow(workflow);
      toast.success(messages().workflowDeactivated);
    },
    onError: (error) => prompts.error(error.message),
  });

  const restore = mutations.create<
    { workflow: MailWorkflowDetail; close: () => void } | null,
    { workflow: MailWorkflow; version: MailWorkflowVersion; close: () => void }
  >({
    mutation: async ({ workflow, version, close }, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().restoreVersionDescription({ identity: version.identity }), {
        title: messages().restoreWorkflowVersion,
        confirmText: messages().restoreAsNewVersion,
        icon: "ti ti-history",
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].versions[":versionId"].restore.$post(
        {
          param: { mailboxId: props.mailboxId, workflowId: workflow.id, versionId: version.id },
          json: { expectedCurrentVersionId: workflow.currentVersionId },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRestoreWorkflowVersion));
      return { workflow: await response.json(), close };
    },
    onSuccess: (result) => {
      if (!result) return;
      replaceWorkflow(result.workflow);
      result.close();
      toast.success(messages().historicalSourceRestored);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    disposed = true;
    activate.abort();
    deactivate.abort();
    restore.abort();
  });

  const openVersion = async (workflow: MailWorkflow, version: MailWorkflowVersion) => {
    await dialogCore.open<void>(
      (close) => (
        <WorkflowVersionViewer
          workflow={workflow}
          version={version}
          close={() => close()}
          restoring={restore.loading()}
          restore={() => restore.mutate({ workflow, version, close: () => close() })}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const toggleVersions = async (workflow: MailWorkflow) => {
    if (expandedWorkflowId() === workflow.id) return setExpandedWorkflowId(null);
    setExpandedWorkflowId(workflow.id);
    if (versions()[workflow.id]) return;
    const response = await apiClient.mailboxes[":mailboxId"].workflows[":workflowId"].versions.$get({
      param: { mailboxId: props.mailboxId, workflowId: workflow.id },
    });
    if (!response.ok) {
      setExpandedWorkflowId(null);
      return prompts.error(await readApiError(response, messages().failedLoadWorkflowVersions));
    }
    const loaded = await response.json();
    if (!disposed) setVersions((current) => ({ ...current, [workflow.id]: loaded }));
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex justify-end">
        <Button size="sm" type="button" onClick={() => void openEditor()}>
          <i class="ti ti-plus" aria-hidden="true" /> {messages().newWorkflow}
        </Button>
      </div>
      <p class="text-xs text-dimmed">{messages().workflowActivityDescription}</p>
      <Show
        when={workflows().length > 0}
        fallback={<Placeholder title={messages().noWorkflows} description={messages().noWorkflowsDescription} icon="ti ti-route-off" />}
      >
        <For each={workflows()}>
          {(workflow) => (
            <div class="paper flex flex-col gap-2 p-3">
              <div class="flex items-center gap-3">
                <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center">
                  <i class="ti ti-route" aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-primary">{workflow.name}</span>
                  <span class="block truncate text-xs text-dimmed">
                    {workflow.description || messages().priorityValue({ priority: workflow.priority })}
                  </span>
                </span>
                <StatusBadge
                  tone={workflow.enabled ? "ok" : "neutral"}
                  label={workflow.enabled ? messages().active : messages().inactive}
                />
                <Show when={workflow.enabled && workflow.activeVersionId !== workflow.currentVersionId}>
                  <StatusBadge tone="warning" label={messages().updateAvailable} />
                </Show>
                <Button variant="ghost" size="sm" type="button" onClick={() => void toggleVersions(workflow)}>
                  <i class="ti ti-history" aria-hidden="true" /> {messages().versions}
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => void openEditor(workflow)}>
                  <i class="ti ti-code" aria-hidden="true" /> {messages().editYaml}
                </Button>
                <Show
                  when={workflow.enabled && workflow.activeVersionId === workflow.currentVersionId}
                  fallback={
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={activate.loading()}
                      onClick={() => activate.mutate(workflow)}
                    >
                      {workflow.enabled ? messages().activateCurrentVersion : messages().activate}
                    </Button>
                  }
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={deactivate.loading()}
                    onClick={() => deactivate.mutate(workflow)}
                  >
                    {messages().deactivate}
                  </Button>
                </Show>
              </div>
              <Show when={expandedWorkflowId() === workflow.id}>
                <div class="flex flex-col gap-1 pl-12">
                  <For each={versions()[workflow.id] ?? []}>
                    {(version) => (
                      <div class="flex items-center gap-2 text-xs text-dimmed">
                        <i
                          class={`ti ${version.id === workflow.activeVersionId ? "ti-circle-check text-green-600" : "ti-git-commit"}`}
                          aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate font-mono">{version.identity}</span>
                        <Show when={version.id === workflow.currentVersionId}>
                          <StatusBadge tone="neutral" label={messages().current} icon={null} />
                        </Show>
                        <Show when={version.id === workflow.activeVersionId}>
                          <StatusBadge tone="ok" label={messages().active} />
                        </Show>
                        <Button variant="ghost" size="xs" type="button" onClick={() => void openVersion(workflow, version)}>
                          {messages().view}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
