import { Button, ButtonLink, prompts } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { BackgroundDocumentState } from "../../custom-apps/background-state";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

export default function BackgroundAction(props: {
  label: string;
  endpoint: string;
  confirm?: string;
  acceptedMessage: string;
  state: BackgroundDocumentState;
}) {
  const t = useCustomAppRuntimeMessages();
  const [state, setState] = createSignal(props.state);
  const [pending, setPending] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [accepted, setAccepted] = createSignal(false);
  let operationId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  const refresh = async () => {
    if (disposed || controller || pending()) return;
    if (document.hidden) {
      schedule();
      return;
    }
    controller = new AbortController();
    try {
      const response = await fetch(props.endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error();
      const next: BackgroundDocumentState = await response.json();
      setState(next);
      if (["failed", "ready", "attention"].includes(next.status)) operationId = undefined;
      setUnavailable(false);
    } catch {
      if (!disposed) setUnavailable(true);
    } finally {
      controller = undefined;
      schedule();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && state().status === "running" && !unavailable()) timer = setTimeout(() => void refresh(), 2000);
  };
  const wake = () => {
    if (!document.hidden) void refresh();
  };
  onMount(() => {
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    onCleanup(() => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    });
    schedule();
  });
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
  });
  const start = async () => {
    if (pending() || state().status === "attention") return;
    if (state().status === "running" || controller) {
      await refresh();
      return;
    }
    if (unavailable()) {
      await refresh();
      return;
    }
    setPending(true);
    try {
      if (props.confirm && !(await prompts.confirm(props.confirm, { title: props.label, confirmText: props.label }))) return;
      if (disposed) return;
      // Keep this key after an ambiguous transport failure. The server also
      // coalesces active requests from other tabs and actors.
      operationId ??= crypto.randomUUID();
      controller = new AbortController();
      const response = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ operationId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      setState(await response.json());
      operationId = undefined;
      setAccepted(true);
      setUnavailable(false);
    } catch {
      if (!disposed) setUnavailable(true);
    } finally {
      controller = undefined;
      setPending(false);
      schedule();
    }
  };
  const message = () =>
    unavailable()
      ? t().workflowStatusUnavailable
      : state().status === "running"
        ? props.acceptedMessage
        : state().status === "attention"
          ? t().documentCreationAttention
          : state().status === "failed"
            ? t().documentCreationFailed
            : state().status === "missing"
              ? t().documentCreationMissing
              : state().status === "ready"
                ? t().documentReady
                : accepted()
                  ? props.acceptedMessage
                  : "";
  return (
    <div class="flex flex-col gap-2">
      <Show
        when={state().status === "ready" && state().downloadUrl}
        fallback={
          <Button
            variant="primary"
            size="sm"
            loading={pending()}
            disabled={pending() || state().status === "attention" || (state().status === "running" && !unavailable())}
            onClick={() => void start()}
          >
            {unavailable()
              ? t().checkWorkflowStatus
              : state().status === "attention"
                ? t().documentFailed
                : state().status === "running"
                  ? t().documentCreating
                  : state().status === "missing" || state().status === "failed"
                    ? t().documentCreationRetry
                    : props.label}
          </Button>
        }
      >
        <ButtonLink href={state().downloadUrl!} target="_blank" variant="primary" size="sm">
          {t().openDocument} · {state().document?.number}
        </ButtonLink>
      </Show>
      <Show when={message()}>
        <p
          role={state().status === "failed" ? "alert" : "status"}
          class={`text-sm ${state().status === "failed" || state().status === "attention" ? "text-danger" : "text-secondary"}`}
        >
          {message()}
        </p>
      </Show>
    </div>
  );
}
