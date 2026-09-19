import { Button, InlineGuidance, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { listWorkflowPromptAttempts, type StoredWorkflowPromptAttempt, WORKFLOW_PROMPT_ATTEMPT_CHANGED } from "./workflow-prompt-session";

/** Outcome recovery stays on the page even when a successful action disappears. */
export default function WorkflowActionRecovery(props: { operationScope: string; pagePath: string; onCompleted?: () => void }) {
  const messages = useCustomAppRuntimeMessages();
  const [attempts, setAttempts] = createSignal<StoredWorkflowPromptAttempt[]>([]);
  const [opening, setOpening] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  let disposed = false;
  const refresh = () => {
    try {
      setAttempts(listWorkflowPromptAttempts(props.operationScope, props.pagePath));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  };
  onMount(() => {
    refresh();
    window.addEventListener(WORKFLOW_PROMPT_ATTEMPT_CHANGED, refresh);
    window.addEventListener("storage", refresh);
  });
  onCleanup(() => {
    disposed = true;
    if (typeof window === "undefined") return;
    window.removeEventListener(WORKFLOW_PROMPT_ATTEMPT_CHANGED, refresh);
    window.removeEventListener("storage", refresh);
  });
  const resume = async (attempt: StoredWorkflowPromptAttempt) => {
    if (opening()) return;
    setOpening(true);
    try {
      const { openWorkflowActionDialog } = await import("./WorkflowActionDialog");
      if (disposed) return;
      const result = await openWorkflowActionDialog({
        action: {
          id: attempt.action.id,
          label: attempt.action.label,
          icon: attempt.action.icon,
          kind: "workflow",
          endpoint: attempt.action.endpoint,
          launcherId: attempt.action.launcherId,
          operationScope: props.operationScope,
          prompt: { inputs: Object.keys(attempt.inputs), successMessage: attempt.action.successMessage },
        },
        session: { draft: attempt.inputs, operation: attempt.operation, submittedInputs: attempt.inputs, unresolved: true },
        onOperationChange: () => {},
      });
      if (result?.kind === "success") {
        toast.success(result.message);
        if (props.onCompleted) props.onCompleted();
        else window.location.reload();
      }
    } catch {
      toast.error(messages().workflowStatusUnavailable);
    } finally {
      setOpening(false);
      refresh();
    }
  };
  return (
    <>
      <Show when={unavailable()}>
        <InlineGuidance tone="warning">{messages().actionPromptStorageFailed}</InlineGuidance>
      </Show>
      <Show when={attempts().length}>
        <InlineGuidance tone="warning">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{messages().actionPromptRecovery}</span>
            <For each={attempts()}>
              {(attempt) => (
                <Button variant="text" size="sm" disabled={opening()} onClick={() => void resume(attempt)}>
                  {messages().actionPromptCheckNamed({ label: attempt.action.label })}
                </Button>
              )}
            </For>
          </div>
        </InlineGuidance>
      </Show>
    </>
  );
}
