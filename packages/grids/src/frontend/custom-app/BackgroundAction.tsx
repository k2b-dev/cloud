import { Button, ButtonLink, InlineGuidance, prompts } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { BackgroundDocumentState } from "../../custom-apps/background-state";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

export default function BackgroundAction(props: {
  label: string;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onCompleted?: () => void;
  variant?: "primary" | "secondary" | "danger";
  endpoint: string;
  launcherId?: string;
  confirm?: string;
  acceptedMessage: string;
  state: BackgroundDocumentState;
}) {
  const t = useCustomAppRuntimeMessages();
  const [state, setState] = createSignal(props.state);
  const [pending, setPending] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [accepted, setAccepted] = createSignal(false);
  const [uncertain, setUncertain] = createSignal(false);
  let observedRunning = props.state.status === "running";
  let completed = false;
  createEffect(() => {
    const status = state().status;
    if (status === "running") observedRunning = true;
    props.onPendingChange?.(
      pending() || uncertain() || Boolean(state().finalized) || ["running", "ready", "attention", "missing"].includes(status),
    );
    if (status === "ready" && observedRunning && !completed) {
      completed = true;
      props.onCompleted?.();
    }
  });
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
      setUncertain(false);
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
    props.onPendingChange?.(false);
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
    if (props.disabled) return;
    setPending(true);
    try {
      if (
        !state().finalized &&
        state().status !== "missing" &&
        props.confirm &&
        !(await prompts.confirm(props.confirm, { title: props.label, confirmText: props.label }))
      )
        return;
      if (disposed || props.disabled) return;
      // Keep this key after an ambiguous transport failure. The server also
      // coalesces active requests from other tabs and actors.
      operationId ??= crypto.randomUUID();
      controller = new AbortController();
      const response = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ operationId, launcherId: props.launcherId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          const body: unknown = await response.json().catch(() => null);
          const message =
            body && typeof body === "object" && "message" in body && typeof body.message === "string"
              ? body.message
              : t().workflowStartFailed;
          operationId = undefined;
          setUncertain(false);
          setUnavailable(false);
          setState((current) => ({ ...current, status: "failed", message }));
          return;
        }
        throw new Error();
      }
      const next: BackgroundDocumentState = await response.json();
      observedRunning = true;
      setUncertain(false);
      setState(next);
      operationId = undefined;
      setAccepted(true);
      setUnavailable(false);
    } catch {
      if (!disposed) {
        setUncertain(true);
        setUnavailable(true);
      }
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
          ? (state().message ?? t().documentCreationAttention)
          : state().status === "failed"
            ? (state().message ?? t().documentCreationFailed)
            : state().status === "missing"
              ? t().documentCreationMissing
              : state().status === "ready"
                ? ""
                : accepted()
                  ? props.acceptedMessage
                  : "";
  return (
    <div class="flex min-w-0 max-w-full flex-col items-start gap-2">
      <Show
        when={state().status === "ready" && state().downloadUrl}
        fallback={
          <Show when={unavailable() || !["running", "attention"].includes(state().status)}>
            <Button
              variant={props.variant ?? "secondary"}
              size="sm"
              loading={pending()}
              loadingLabel={t().starting}
              disabled={(props.disabled && !unavailable()) || pending()}
              onClick={() => void start()}
            >
              {unavailable()
                ? t().checkWorkflowStatus
                : state().status === "missing" || state().status === "failed"
                  ? t().documentCreationRetry
                  : props.label}
            </Button>
          </Show>
        }
      >
        <ButtonLink href={state().downloadUrl!} target="_blank" variant={props.variant ?? "secondary"} size="sm">
          {t().openDocument} · {state().document?.number}
        </ButtonLink>
      </Show>
      <Show when={message()}>
        <InlineGuidance
          loading={state().status === "running" && !unavailable()}
          role={state().status === "failed" || state().status === "attention" ? "alert" : "status"}
          tone={state().status === "failed" || state().status === "attention" ? "danger" : "neutral"}
        >
          {message()}
        </InlineGuidance>
      </Show>
    </div>
  );
}
