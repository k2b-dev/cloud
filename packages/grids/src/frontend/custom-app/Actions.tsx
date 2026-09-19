import { Button, ButtonLink, Dropdown, prompts, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { BackgroundDocumentState } from "../../custom-apps/background-state";
import type { CustomAppAction } from "../../custom-apps/contracts";
import { openFinancialExportDialog } from "../_components/workflows/FinancialExportDialog";
import BackgroundAction from "./BackgroundAction";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import type { WorkflowPromptSession } from "./WorkflowActionDialog";
import { type CustomAppWorkflowOperation, CustomAppWorkflowStartRejected, invokeCustomAppWorkflow } from "./workflow-action-client";

export type CustomAppRenderedAction =
  | {
      id: string;
      kind: "navigate";
      label: string;
      icon?: string;
      variant?: "primary" | "secondary" | "danger";
      href: string;
      history: "push" | "replace";
    }
  | {
      id: string;
      kind: "workflow";
      label: string;
      icon?: string;
      variant?: "primary" | "secondary" | "danger";
      endpoint: string;
      launcherId: string;
      confirm?: string;
      prompt?: Extract<CustomAppAction, { kind: "workflow" }>["prompt"];
      operationScope?: string;
      background?: { acceptedMessage: string; state: BackgroundDocumentState };
    };

export default function Actions(props: {
  actions: CustomAppRenderedAction[];
  compactDanger?: boolean;
  disabled?: boolean;
  disabledActionIds?: string[];
  onPendingChange?: (pending: boolean) => void;
  onCompleted?: () => void;
}) {
  const messages = useCustomAppRuntimeMessages();
  const disabled = (actionId: string) => Boolean(props.disabled || props.disabledActionIds?.includes(actionId));
  const [promptId, setPromptId] = createSignal<string | null>(null);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [backgroundPending, setBackgroundPending] = createSignal<Record<string, boolean>>({});
  const promptSessions = new Map<string, WorkflowPromptSession>();
  const uncertainOperations = new Set<string>();
  const [operations, setOperations] = createSignal<Record<string, CustomAppWorkflowOperation>>({});
  createEffect(() =>
    props.onPendingChange?.(
      Boolean(pendingId()) || Object.values(backgroundPending()).some(Boolean) || Object.keys(operations()).length > 0,
    ),
  );

  const dangerActions = () =>
    props.compactDanger
      ? props.actions.filter(
          (action): action is Extract<CustomAppRenderedAction, { kind: "workflow" }> =>
            action.kind === "workflow" && action.variant === "danger" && !action.background,
        )
      : [];
  const visibleActions = () => props.actions.filter((action) => !dangerActions().some((danger) => danger.id === action.id));
  const [status, setStatus] = createSignal<{ kind: "running" | "success" | "error"; message: string } | null>(null);
  const anotherOperationPending = (actionId: string) =>
    (pendingId() !== null && pendingId() !== actionId) ||
    Object.entries(backgroundPending()).some(([id, pending]) => id !== actionId && pending) ||
    Object.keys(operations()).some((id) => id !== actionId);
  let controller: AbortController | null = null;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
    props.onPendingChange?.(false);
  });

  const invoke = async (action: Extract<CustomAppRenderedAction, { kind: "workflow" }>) => {
    if (disabled(action.id) || pendingId() || anotherOperationPending(action.id)) return;
    setPendingId(action.id);
    setStatus(null);
    try {
      if (action.prompt) {
        const { openWorkflowActionDialog } = await import("./WorkflowActionDialog");
        if (disposed) return;
        const { listWorkflowPromptAttempts } = await import("./workflow-prompt-session");
        const retained = action.operationScope ? listWorkflowPromptAttempts(action.operationScope, action.endpoint)[0] : undefined;
        const promptedAction: Extract<CustomAppRenderedAction, { kind: "workflow" }> = retained
          ? {
              ...retained.action,
              kind: "workflow",
              operationScope: action.operationScope,
              prompt: { inputs: Object.keys(retained.inputs), successMessage: retained.action.successMessage },
            }
          : action;
        const session = retained
          ? { draft: retained.inputs, operation: retained.operation, submittedInputs: retained.inputs, unresolved: true }
          : (promptSessions.get(action.id) ?? { draft: {} });
        promptSessions.set(action.id, session);
        setPromptId(action.id);
        const outcome = await openWorkflowActionDialog({
          action: promptedAction,
          session,
          onOperationChange: (operation) =>
            setOperations((current) =>
              operation
                ? { ...current, [action.id]: operation }
                : Object.fromEntries(Object.entries(current).filter(([id]) => id !== action.id)),
            ),
        });
        if (disposed) return;
        if (outcome?.kind === "success") {
          promptSessions.delete(action.id);
          toast.success(outcome.message);
          if (props.onCompleted) props.onCompleted();
          else if (outcome.navigateTo) window.location.replace(outcome.navigateTo);
          else window.location.reload();
        }
        return;
      }
      if (
        !operations()[action.id] &&
        action.confirm &&
        !(await prompts.confirm(action.confirm, {
          title: action.label,
          confirmText: action.label,
          ...(action.variant === "danger" ? { variant: "danger" as const } : {}),
        }))
      )
        return;
      if (disposed || disabled(action.id) || anotherOperationPending(action.id)) return;
      controller = new AbortController();
      const operation = operations()[action.id] ?? { operationId: crypto.randomUUID() };
      setOperations((current) => ({ ...current, [action.id]: operation }));
      const outcome = await invokeCustomAppWorkflow({
        operation,
        onConfirmExport: openFinancialExportDialog,
        endpoint: action.endpoint,
        body: { launcherId: action.launcherId },
        signal: controller.signal,
        onRunning: () => setStatus({ kind: "running", message: messages().workflowRunning }),
        messages: {
          startFailed: messages().workflowStartFailed,
          statusUnavailable: messages().workflowStatusUnavailable,
          completed: messages().workflowCompleted,
          failed: messages().workflowFailed,
          stillRunning: messages().workflowStillRunning,
          awaitingExport: messages().workflowAwaitingExport,
        },
      });
      setStatus(outcome);
      if (outcome.kind !== "running") {
        uncertainOperations.delete(action.id);
        setOperations((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== action.id)));
      } else uncertainOperations.add(action.id);
      if (outcome.kind === "success") {
        if (outcome.navigateTo) window.location.replace(outcome.navigateTo);
        else window.location.reload();
      }
    } catch (cause) {
      if (controller?.signal.aborted) return;
      if (cause instanceof CustomAppWorkflowStartRejected && !uncertainOperations.has(action.id))
        setOperations((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== action.id)));
      else if (operations()[action.id]) uncertainOperations.add(action.id);
      setStatus({ kind: "error", message: cause instanceof Error ? cause.message : messages().workflowStartFailed });
    } finally {
      controller = null;
      setPendingId(null);
      setPromptId(null);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-start gap-2">
        <For each={visibleActions()}>
          {(action) => (
            <Show
              when={action.kind === "workflow" && action.background ? action : undefined}
              fallback={
                <Show
                  when={action.kind === "workflow"}
                  fallback={
                    <ButtonLink
                      href={disabled(action.id) ? undefined : (action as Extract<CustomAppRenderedAction, { kind: "navigate" }>).href}
                      aria-disabled={disabled(action.id) || undefined}
                      tabIndex={disabled(action.id) ? -1 : undefined}
                      onClick={(event) => {
                        if (disabled(action.id)) {
                          event.preventDefault();
                          return;
                        }
                        const navigateAction = action as Extract<CustomAppRenderedAction, { kind: "navigate" }>;
                        if (
                          navigateAction.history !== "replace" ||
                          event.defaultPrevented ||
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey ||
                          (event.currentTarget.target && event.currentTarget.target !== "_self") ||
                          event.currentTarget.hasAttribute("download")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        window.location.replace(navigateAction.href);
                      }}
                      variant={action.variant ?? "secondary"}
                      size="sm"
                    >
                      <Show when={action.icon}>
                        <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                      </Show>
                      {action.label}
                    </ButtonLink>
                  }
                >
                  <Button
                    variant={action.variant ?? "secondary"}
                    size="sm"
                    loading={pendingId() === action.id && promptId() !== action.id}
                    loadingLabel={action.kind === "workflow" && action.prompt ? messages().openingForm : messages().starting}
                    disabled={disabled(action.id) || Boolean(pendingId()) || anotherOperationPending(action.id)}
                    onClick={() => void invoke(action as Extract<CustomAppRenderedAction, { kind: "workflow" }>)}
                  >
                    <Show when={action.icon}>
                      <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                    </Show>
                    {operations()[action.id] ? messages().checkWorkflowStatus : action.label}
                  </Button>
                </Show>
              }
            >
              {(backgroundAction) => (
                <BackgroundAction
                  disabled={disabled(backgroundAction().id) || anotherOperationPending(backgroundAction().id)}
                  onPendingChange={(pending) => setBackgroundPending((current) => ({ ...current, [backgroundAction().id]: pending }))}
                  onCompleted={props.onCompleted}
                  {...backgroundAction()}
                  {...backgroundAction().background!}
                />
              )}
            </Show>
          )}
        </For>
        <Show when={dangerActions().length > 0}>
          <Dropdown.Root
            position="bottom-right"
            items={dangerActions().map((action) => ({
              label: operations()[action.id] ? messages().checkWorkflowStatus : action.label,
              icon: action.icon ? `ti ti-${action.icon}` : undefined,
              variant: "danger" as const,
              disabled: disabled(action.id) || Boolean(pendingId()) || anotherOperationPending(action.id),
              action: () => void invoke(action),
            }))}
          >
            <Dropdown.Trigger variant="ghost" size="sm" aria-label={messages().moreActions}>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </Show>
      </div>
      <Show when={status()}>
        {(current) => (
          <p
            role={current().kind === "error" ? "alert" : "status"}
            class={`text-sm ${current().kind === "error" ? "text-danger" : current().kind === "success" ? "text-success" : "text-secondary"}`}
          >
            {current().message}
          </p>
        )}
      </Show>
    </div>
  );
}
