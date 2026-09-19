import type { WorkflowIrInput, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { Button, dialogCore, InlineGuidance, NoticeCard, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { CustomAppWorkflowPromptResponseSchema } from "../../custom-apps/workflow-prompt";
import { openFinancialExportDialog } from "../_components/workflows/FinancialExportDialog";
import { WorkflowInputFields } from "../_components/workflows/WorkflowInputFields";
import { buildWorkflowRunInput, type WorkflowRunInputDraft } from "../_components/workflows/workflow-trigger-actions";
import type { CustomAppRenderedAction } from "./Actions";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import {
  type CustomAppWorkflowOperation,
  type CustomAppWorkflowOutcome,
  CustomAppWorkflowStartRejected,
  invokeCustomAppWorkflow,
} from "./workflow-action-client";
import {
  clearWorkflowPromptAttempt,
  readWorkflowPromptAttempt,
  storeWorkflowPromptAttempt,
  workflowPromptSessionKey,
} from "./workflow-prompt-session";

export type WorkflowPromptSession = {
  draft: WorkflowRunInputDraft;
  operation?: CustomAppWorkflowOperation;
  submittedInputs?: Record<string, WorkflowJsonValue>;
  unresolved?: boolean;
};

type Props = {
  action: Extract<CustomAppRenderedAction, { kind: "workflow" }>;
  session: WorkflowPromptSession;
  onOperationChange: (operation: CustomAppWorkflowOperation | undefined) => void;
  close: (outcome?: CustomAppWorkflowOutcome) => void;
  setDismissHandler: (handler: () => void) => void;
};

export function WorkflowActionDialog(props: Props) {
  const locale = useLocale();
  const messages = useCustomAppRuntimeMessages();
  const storageKey = props.action.operationScope ? workflowPromptSessionKey(props.action.operationScope, props.action.endpoint) : undefined;
  let storedAction = {
    id: props.action.id,
    label: props.action.label,
    icon: props.action.icon,
    endpoint: props.action.endpoint,
    launcherId: props.action.launcherId,
    successMessage: props.action.prompt?.successMessage,
  };
  let storageReady = Boolean(storageKey);
  try {
    const attempt = storageKey ? readWorkflowPromptAttempt(storageKey) : undefined;
    if (attempt) storedAction = { ...storedAction, ...attempt.action };
    if (attempt && !props.session.operation) {
      props.session.operation = attempt.operation;
      props.session.submittedInputs = attempt.inputs;
      props.session.draft = attempt.inputs;
      props.session.unresolved = true;
      props.onOperationChange(attempt.operation);
    }
  } catch {
    storageReady = false;
  }
  const clearAttempt = () => {
    try {
      if (storageKey) clearWorkflowPromptAttempt(storageKey);
    } catch {
      /* A retained completed handle safely replays on the next visit. */
    }
  };
  const [inputs, setInputs] = createSignal<WorkflowIrInput[]>();
  const [draft, setDraft] = createSignal(props.session.draft);
  const [touched, setTouched] = createSignal(new Set(Object.keys(props.session.draft)));
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [uncertain, setUncertain] = createSignal(Boolean(props.session.operation));
  const validation = createMemo(() => buildWorkflowRunInput(inputs() ?? [], draft(), locale()));
  let controller = new AbortController();
  const dismiss = () => {
    if (!busy()) props.close();
  };
  props.setDismissHandler(dismiss);
  onCleanup(() => controller.abort());
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(props.action.endpoint, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(messages().actionPromptLoadFailed);
      setInputs(CustomAppWorkflowPromptResponseSchema.parse(await response.json()).inputs);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : messages().actionPromptLoadFailed);
    } finally {
      setLoading(false);
    }
  };
  onMount(() => {
    if (storageReady) void load();
    else {
      setError(messages().actionPromptStorageFailed);
      setLoading(false);
    }
  });
  const submit = async () => {
    if (busy() || !storageReady || !storageKey) return;
    const current = validation();
    if (!props.session.operation && (!inputs() || !current.ok)) return;
    setBusy(true);
    setError(undefined);
    controller = new AbortController();
    try {
      if (!props.session.operation && current.ok) {
        const operation = { operationId: crypto.randomUUID() };
        try {
          storeWorkflowPromptAttempt(storageKey, storedAction, operation, current.input);
        } catch {
          setError(messages().actionPromptStorageFailed);
          return;
        }
        props.session.submittedInputs = current.input;
        props.session.operation = operation;
      }
      props.onOperationChange(props.session.operation);
      setUncertain(true);
      const result = await invokeCustomAppWorkflow({
        endpoint: props.action.endpoint,
        operation: props.session.operation,
        body: { inputs: props.session.submittedInputs, launcherId: storedAction.launcherId },
        signal: controller.signal,
        onConfirmExport: openFinancialExportDialog,
        onRunning: () => {
          if (props.session.operation && props.session.submittedInputs)
            storeWorkflowPromptAttempt(storageKey, storedAction, props.session.operation, props.session.submittedInputs);
        },
        messages: {
          startFailed: messages().workflowStartFailed,
          statusUnavailable: messages().workflowStatusUnavailable,
          completed: props.action.prompt?.successMessage ?? messages().workflowCompleted,
          failed: messages().workflowFailed,
          stillRunning: messages().workflowStillRunning,
          awaitingExport: messages().workflowAwaitingExport,
        },
      });
      if (result.kind !== "running") {
        clearAttempt();
        props.session.operation = undefined;
        props.onOperationChange(undefined);
        props.session.unresolved = false;
        setUncertain(false);
      } else props.session.unresolved = true;
      if (result.kind === "success") props.close({ ...result, message: props.action.prompt?.successMessage ?? result.message });
      else setError(result.message);
    } catch (cause) {
      if (cause instanceof CustomAppWorkflowStartRejected && !props.session.unresolved) {
        clearAttempt();
        props.session.operation = undefined;
        props.onOperationChange(undefined);
        setUncertain(false);
      } else props.session.unresolved = true;
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : messages().workflowStartFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.action.label}
        icon={props.action.icon ? `ti ti-${props.action.icon}` : undefined}
        close={dismiss}
        closeDisabled={busy()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <Show when={props.action.prompt?.description}>
            {(description) => <InlineGuidance tone="neutral">{description()}</InlineGuidance>}
          </Show>
          <Show when={loading()}>
            <p role="status" class="text-sm text-secondary">
              {messages().actionPromptLoading}
            </p>
          </Show>
          <Show when={inputs()}>
            {(definitions) => (
              <fieldset disabled={busy() || uncertain()} class="min-w-0">
                <WorkflowInputFields
                  workflow={{ plan: { inputs: definitions(), bindings: {} } }}
                  tables={[]}
                  draft={draft}
                  onValueChange={(name, value) => {
                    const next = { ...draft(), [name]: value };
                    props.session.draft = next;
                    setTouched((current) => new Set([...current, name]));
                    setDraft(next);
                  }}
                  errors={() => {
                    const result = validation();
                    return result.ok ? {} : Object.fromEntries(Object.entries(result.errors).filter(([name]) => touched().has(name)));
                  }}
                />
              </fieldset>
            )}
          </Show>
          <Show when={error()}>{(message) => <NoticeCard tone={uncertain() ? "warning" : "danger"}>{message()}</NoticeCard>}</Show>
          <Show when={uncertain() && !busy()}>
            <InlineGuidance tone="neutral">{messages().actionPromptUncertain}</InlineGuidance>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" disabled={busy()} onClick={dismiss}>
          {messages().actionPromptClose}
        </Button>
        <Button
          variant={props.action.variant ?? "primary"}
          size="sm"
          loading={busy()}
          loadingLabel={messages().workflowRunning}
          disabled={!storageReady || loading() || (!uncertain() && Boolean(inputs()) && !validation().ok)}
          onClick={() => void (inputs() || uncertain() ? submit() : load())}
        >
          {uncertain() ? messages().checkWorkflowStatus : props.action.label}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openWorkflowActionDialog = (props: Omit<Props, "close" | "setDismissHandler">) =>
  dialogCore.open<CustomAppWorkflowOutcome>(
    (close, context) => <WorkflowActionDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />,
    { ...panelDialogOptions, panelClassName: "k2b-dialog k2b-dialog--medium" },
  );
