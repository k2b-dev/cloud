import { Button, ButtonLink, prompts } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { type CustomAppWorkflowOperation, invokeCustomAppWorkflow } from "./workflow-action-client";

export type CustomAppRenderedAction =
  | {
      id: string;
      kind: "navigate";
      label: string;
      icon?: string;
      href: string;
      history: "push" | "replace";
    }
  | {
      id: string;
      kind: "workflow";
      label: string;
      icon?: string;
      endpoint: string;
      confirm?: string;
    };

export default function Actions(props: { actions: CustomAppRenderedAction[] }) {
  const messages = useCustomAppRuntimeMessages();
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [operations, setOperations] = createSignal<Record<string, CustomAppWorkflowOperation>>({});
  const [status, setStatus] = createSignal<{ kind: "running" | "success" | "error"; message: string } | null>(null);
  let controller: AbortController | null = null;
  let reloadTimer: number | null = null;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  });

  const invoke = async (action: Extract<CustomAppRenderedAction, { kind: "workflow" }>) => {
    if (pendingId()) return;
    setPendingId(action.id);
    setStatus(null);
    try {
      if (
        !operations()[action.id] &&
        action.confirm &&
        !(await prompts.confirm(action.confirm, {
          title: action.label,
          confirmText: action.label,
        }))
      )
        return;
      if (disposed) return;
      controller = new AbortController();
      const operation = operations()[action.id] ?? { operationId: crypto.randomUUID() };
      setOperations((current) => ({ ...current, [action.id]: operation }));
      const outcome = await invokeCustomAppWorkflow({
        operation,
        endpoint: action.endpoint,
        signal: controller.signal,
        onRunning: () => setStatus({ kind: "running", message: messages().workflowRunning }),
        messages: {
          startFailed: messages().workflowStartFailed,
          statusUnavailable: messages().workflowStatusUnavailable,
          completed: messages().workflowCompleted,
          failed: messages().workflowFailed,
          stillRunning: messages().workflowStillRunning,
        },
      });
      setStatus(outcome);
      if (outcome.kind !== "running")
        setOperations((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== action.id)));
      if (outcome.kind === "success") reloadTimer = window.setTimeout(() => window.location.reload(), 600);
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
              when={action.kind === "workflow"}
              fallback={
                <ButtonLink
                  href={(action as Extract<CustomAppRenderedAction, { kind: "navigate" }>).href}
                  onClick={(event) => {
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
                  variant="secondary"
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
                variant="primary"
                size="sm"
                loading={pendingId() === action.id}
                loadingLabel={messages().starting}
                disabled={Boolean(pendingId())}
                onClick={() => void invoke(action as Extract<CustomAppRenderedAction, { kind: "workflow" }>)}
              >
                <Show when={action.icon}>
                  <i class={`ti ti-${action.icon}`} aria-hidden="true" />
                </Show>
                {operations()[action.id] ? messages().checkWorkflowStatus : action.label}
              </Button>
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
