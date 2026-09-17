import { Button, ButtonLink, prompts } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { BackgroundDocumentState } from "../../custom-apps/background-state";
import { openFinancialExportDialog } from "../_components/workflows/FinancialExportDialog";
import BackgroundAction from "./BackgroundAction";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { type CustomAppWorkflowOperation, invokeCustomAppWorkflow } from "./workflow-action-client";

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
      confirm?: string;
      background?: { acceptedMessage: string; state: BackgroundDocumentState };
    };

export default function Actions(props: {
  actions: CustomAppRenderedAction[];
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onCompleted?: () => void;
}) {
  const messages = useCustomAppRuntimeMessages();
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [backgroundPending, setBackgroundPending] = createSignal<Record<string, boolean>>({});
  const [operations, setOperations] = createSignal<Record<string, CustomAppWorkflowOperation>>({});
  createEffect(() =>
    props.onPendingChange?.(
      Boolean(pendingId()) || Object.values(backgroundPending()).some(Boolean) || Object.keys(operations()).length > 0,
    ),
  );

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
    if (props.disabled || pendingId() || anotherOperationPending(action.id)) return;
    setPendingId(action.id);
    setStatus(null);
    try {
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
      if (disposed || props.disabled || anotherOperationPending(action.id)) return;
      controller = new AbortController();
      const operation = operations()[action.id] ?? { operationId: crypto.randomUUID() };
      setOperations((current) => ({ ...current, [action.id]: operation }));
      const outcome = await invokeCustomAppWorkflow({
        operation,
        onConfirmExport: openFinancialExportDialog,
        endpoint: action.endpoint,
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
      if (outcome.kind !== "running")
        setOperations((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== action.id)));
      if (outcome.kind === "success") {
        if (outcome.navigateTo) window.location.replace(outcome.navigateTo);
        else window.location.reload();
      }
    } catch (cause) {
      if (controller?.signal.aborted) return;
      setStatus({ kind: "error", message: cause instanceof Error ? cause.message : messages().workflowStartFailed });
    } finally {
      controller = null;
      setPendingId(null);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <For each={props.actions}>
          {(action) => (
            <Show
              when={action.kind === "workflow" && action.background ? action : undefined}
              fallback={
                <Show
                  when={action.kind === "workflow"}
                  fallback={
                    <ButtonLink
                      href={props.disabled ? undefined : (action as Extract<CustomAppRenderedAction, { kind: "navigate" }>).href}
                      aria-disabled={props.disabled || undefined}
                      tabIndex={props.disabled ? -1 : undefined}
                      onClick={(event) => {
                        if (props.disabled) {
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
                    loading={pendingId() === action.id}
                    loadingLabel={messages().starting}
                    disabled={props.disabled || Boolean(pendingId()) || anotherOperationPending(action.id)}
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
                  disabled={props.disabled || anotherOperationPending(backgroundAction().id)}
                  onPendingChange={(pending) => setBackgroundPending((current) => ({ ...current, [backgroundAction().id]: pending }))}
                  onCompleted={props.onCompleted}
                  {...backgroundAction()}
                  {...backgroundAction().background!}
                />
              )}
            </Show>
          )}
        </For>
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
