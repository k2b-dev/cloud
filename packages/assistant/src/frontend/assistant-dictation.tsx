import { query } from "@k2b/stdlib/solid";
import { Button, Dropdown, IconButton, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import { type AssistantLiveInvalidation, type createAssistantLiveInvalidationHub, matchesAssistantInvalidation } from "./assistant-live";
import { audioMessages } from "./audio-messages";
import { startAudioRecording } from "./audio-recorder";

type Dictation = {
  id: string;
  sourcePath: string;
  operationId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  disposition: "pending" | "applied" | "discarded";
  text?: string | null;
};
type Operation = {
  key: string;
  target: string;
  generation: number;
  operationId: string;
  id?: string;
  blob?: Blob;
  auto: boolean;
  canceled: boolean;
  upload?: AbortController;
};
type Phase = "idle" | "starting" | "recording" | "finalizing" | "uploading" | "processing" | "discarding" | "retrying";
type Failure = { key: string; message: string; retry: () => Promise<void>; discard?: () => Promise<void> };
const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/ai${path}`, init);
  if (!response.ok) throw new Error(`Audio request failed (${response.status}).`);
  return response.json();
};
const endpoint = (target: string, id?: string) => `/conversations/${target}/dictations${id ? `/${id}` : ""}`;
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const createAssistantDictation = (props: {
  configured: () => boolean;
  key: () => string;
  target: () => string | null;
  ensureTarget: () => Promise<{ key: string; target: string } | null>;
  generation: (key: string) => number;
  live: ReturnType<typeof createAssistantLiveInvalidationHub>;
  apply: (key: string, target: string, id: string) => Promise<boolean>;
}) => {
  const locale = useLocale();
  const t = () => audioMessages.resolve([locale()]).t;
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [levels, setLevels] = createSignal<number[]>(Array(48).fill(0));
  const [settledOperations, setSettledOperations] = createSignal<ReadonlySet<string>>(new Set());
  const settleOperation = (id: string) => setSettledOperations((previous) => new Set([...previous, id]));
  const [applying, setApplying] = createSignal(false);
  const [own, setOwn] = createSignal<Operation>();
  const [failure, setFailure] = createSignal<Failure>();
  const [retrying, setRetrying] = createSignal(false);
  let notice: ToastHandle | undefined;
  let recording: Awaited<ReturnType<typeof startAudioRecording>> | undefined;
  let disposed = false;
  const target = () => own()?.target ?? props.target();
  const clearFailure = () => {
    notice?.dismiss();
    notice = undefined;
    setFailure(undefined);
  };
  const retry = async () => {
    const current = failure();
    if (!current || retrying() || disposed) return;
    setRetrying(true);
    clearFailure();
    try {
      await current.retry();
    } catch {
      fail(current.key, current.message, current.retry, current.discard);
    } finally {
      setRetrying(false);
    }
  };
  const fail = (key: string, message: string, retryAction: () => Promise<void>, discardAction?: () => Promise<void>) => {
    if (disposed || failure()?.key === key) return;
    clearFailure();
    setFailure({ key, message, retry: retryAction, discard: discardAction });
    notice = toast.error(message, { duration: 0, action: { label: t().retry, onClick: () => void retry() } });
  };
  const list = query.create<string | null, { target: string | null; items: Dictation[] }, AssistantLiveInvalidation>({
    source: target,
    load: async (bound, { abortSignal }) => {
      if (!bound) return { target: bound, items: [] };
      const all: Dictation[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Dictation[]; nextCursor: string | null } = await request(
          `${endpoint(bound)}${cursor ? `?after=${cursor}` : ""}`,
          { signal: abortSignal },
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const task = own();
      // A different tab may already have applied/discarded our job.
      if (task?.target === bound && task.id && !all.some((item) => item.id === task.id)) {
        all.push(await request<Dictation>(endpoint(bound, task.id), { signal: abortSignal }));
      }
      return { target: bound, items: all };
    },
  });
  const items = () => (list.data()?.target === target() ? list.data()!.items : []);
  const pending = () => items().find((item) => item.disposition === "pending" && !settledOperations().has(item.operationId));
  const refresh = async () => {
    await list.refresh();
  };
  const unregister = props.live.register({
    matches: (event) =>
      Boolean(target()) && matchesAssistantInvalidation(["conversation-dictations"], { conversationId: target()! })(event),
    invalidate: (event) => list.invalidate(event),
  });
  const refreshAfter = async () => {
    try {
      await refresh();
    } catch {
      fail("refresh", t().statusFailed, refresh);
    }
  };
  const apply = async (item: Dictation, key: string, bound: string, automatic = false) => {
    if (disposed || applying()) return;
    const task = own();
    if (
      automatic &&
      (!task?.auto || task.canceled || task.id !== item.id || task.key !== props.key() || task.generation !== props.generation(key))
    )
      return;
    if (task) task.auto = false;
    setApplying(true);
    try {
      if (await props.apply(key, bound, item.id)) {
        settleOperation(item.operationId);
        clearFailure();
        if (own()?.operationId === item.operationId) {
          setOwn(undefined);
          setPhase("idle");
        }
        await refreshAfter();
      } else
        fail(
          `apply:${item.id}`,
          t().applyFailed,
          () => apply(item, key, bound),
          () => discard(bound, item.operationId),
        );
    } catch {
      fail(
        `apply:${item.id}`,
        t().applyFailed,
        () => apply(item, key, bound),
        () => discard(bound, item.operationId),
      );
    } finally {
      setApplying(false);
    }
  };
  const retryJob = async (item: Dictation, bound: string) => {
    setPhase("retrying");
    try {
      await request(`${endpoint(bound, item.id)}/action`, post({ action: "retry" }));
      await refreshAfter();
    } catch {
      fail(
        `job:${item.id}`,
        t().failed,
        () => retryJob(item, bound),
        () => discard(bound, item.operationId),
      );
    } finally {
      setPhase("idle");
    }
  };
  const upload = async (task: Operation) => {
    if (disposed || task.canceled || !task.blob || task.upload) return;
    setPhase("uploading");
    const controller = new AbortController();
    task.upload = controller;
    try {
      const form = new FormData();
      form.append("operationId", task.operationId);
      form.append("file", task.blob, "dictation.wav");
      const item = await request<Dictation>(endpoint(task.target), { method: "POST", body: form, signal: controller.signal });
      if (disposed || task.canceled) return;
      task.id = item.id;
      task.blob = undefined;
      clearFailure();
      setPhase("processing");
      await refreshAfter();
    } catch {
      if (!disposed && !task.canceled) {
        setPhase("idle");
        fail(
          `upload:${task.operationId}`,
          t().uploadFailed,
          () => upload(task),
          () => discard(task.target, task.operationId),
        );
      }
    } finally {
      task.upload = undefined;
    }
  };
  const stop = async () => {
    const task = own();
    if (!recording || !task || phase() !== "recording") return;
    const current = recording;
    recording = undefined;
    setPhase("finalizing");
    try {
      const blob = await current.stop();
      if (disposed || task.canceled) return;
      task.blob = blob;
      await upload(task);
    } catch {
      if (!disposed && !task.canceled) {
        setOwn(undefined);
        setPhase("idle");
        fail("record", t().recordFailed, start);
      }
    }
  };
  const start = async () => {
    if (disposed || !props.configured() || phase() !== "idle" || pending() || own()) return;
    setPhase("starting");
    try {
      const bound = await props.ensureTarget();
      if (!bound || disposed) {
        setPhase("idle");
        return;
      }
      const task: Operation = {
        ...bound,
        generation: props.generation(bound.key),
        operationId: crypto.randomUUID(),
        auto: true,
        canceled: false,
      };
      setOwn(task);
      setLevels(Array(48).fill(0));
      const next = await startAudioRecording(
        () => void stop(),
        (rms) => {
          if (!disposed && !task.canceled) setLevels((previous) => [...previous.slice(1), Math.min(1, Math.sqrt(rms) * 2.5)]);
        },
      );
      if (disposed || task.canceled || props.key() !== bound.key) {
        next.discard();
        setOwn(undefined);
        setPhase("idle");
        return;
      }
      recording = next;
      setPhase("recording");
    } catch {
      setOwn(undefined);
      setPhase("idle");
      fail("record", t().recordFailed, start);
    }
  };
  const discard = async (bound: string, operationId: string) => {
    if (disposed || applying() || phase() === "discarding") return;
    const task = own();
    if (task?.operationId === operationId) {
      task.auto = false;
      task.canceled = true;
      task.upload?.abort();
      recording?.discard();
      recording = undefined;
    }
    setPhase("discarding");
    clearFailure();
    try {
      const result = await request<{ disposition: "applied" | "discarded" }>(`${endpoint(bound)}/discard`, post({ operationId }));
      if (disposed) return;
      if (result.disposition === "applied") toast(t().alreadyInserted, { duration: 0 });
      // Commit the acknowledgement locally before clearing the owner or refreshing.
      // The query still contains its previous failed/pending row at this point.
      settleOperation(operationId);
      clearFailure();
      if (own()?.operationId === operationId) setOwn(undefined);
      setPhase("idle");
      await refreshAfter();
    } catch {
      if (!disposed) {
        setPhase("idle");
        fail(`discard:${operationId}`, t().discardFailed, () => discard(bound, operationId));
      }
    }
  };
  createEffect(() => {
    const task = own();
    const key = props.key();
    if (task && key !== task.key) {
      task.auto = false;
      if (phase() === "recording") void stop();
    }
  });
  createEffect(() => {
    if (phase() === "discarding" || applying()) return;
    if (list.error()) fail("refresh", t().statusFailed, refresh);
    const task = own();
    const found = task ? items().find((item) => item.operationId === task.operationId) : undefined;
    if (found && !task!.canceled) {
      task!.id = found.id;
      task!.blob = undefined;
      if (found.disposition !== "pending") {
        clearFailure();
        setOwn(undefined);
        setPhase("idle");
        return;
      }
      if (failure()?.key === `upload:${task!.operationId}`) {
        clearFailure();
        setPhase("processing");
      }
    }
    const item = pending();
    const bound = target();
    if (!item || !bound || task?.canceled || phase() === "retrying" || retrying()) return;
    if (item.status === "failed") {
      setPhase("idle");
      fail(
        `job:${item.id}`,
        t().failed,
        () => retryJob(item, bound),
        () => discard(bound, item.operationId),
      );
    } else if (item.status === "succeeded") {
      setPhase("idle");
      if (task?.auto && task.key === props.key() && task.generation === props.generation(task.key)) void apply(item, task.key, bound, true);
      // Away from its composer: leave the durable result for explicit insertion on return.
      else if (task && task.key !== props.key()) setOwn(undefined);
    }
  });
  const processing = () =>
    ["finalizing", "uploading", "processing"].includes(phase()) || ["queued", "running"].includes(pending()?.status ?? "");
  const busy = () => phase() !== "idle" || applying() || retrying() || processing();
  const cancelable = () => !failure() && !applying() && phase() !== "discarding" && !retrying() && processing();
  const label = () =>
    applying()
      ? t().inserting
      : phase() === "discarding"
        ? t().discarding
        : failure()
          ? t().retry
          : phase() === "recording"
            ? t().stop
            : cancelable()
              ? t().discardDictation
              : phase() === "starting"
                ? t().starting
                : pending()?.status === "succeeded"
                  ? t().insert
                  : !props.configured()
                    ? t().microphoneUnavailable
                    : t().dictate;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (recording || own()?.blob || own()?.canceled) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => {
    disposed = true;
    recording?.discard();
    own()?.upload?.abort();
    notice?.dismiss();
    unregister();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnload);
  });
  return {
    busy,
    recording: () => phase() === "recording",
    RecordingFooter: () => (
      <div class="assistant-recording-footer">
        <IconButton
          size="sm"
          class="assistant-recording-action"
          label={t().discardDictation}
          onClick={() => {
            const task = own();
            if (task) void discard(task.target, task.operationId);
          }}
        >
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
        <div class="assistant-recording-wave" aria-hidden="true">
          <Index each={levels()}>{(level) => <span style={{ "--audio-scale": String(0.12 + level() * 0.88) }} />}</Index>
        </div>
        <IconButton size="sm" class="assistant-recording-action" label={t().stop} onClick={() => void stop()}>
          <span class="assistant-recording-stop" aria-hidden="true" />
        </IconButton>
      </div>
    ),
    invalidateAutomatic: () => {
      const task = own();
      if (task) task.auto = false;
    },
    Control: () => (
      <Show
        when={failure() && !retrying()}
        fallback={
          <IconButton
            size="sm"
            class="assistant-dictation-control"
            label={label()}
            data-recording={phase() === "recording"}
            data-cancelable={cancelable()}
            data-failed={Boolean(failure())}
            disabled={
              applying() ||
              retrying() ||
              phase() === "starting" ||
              phase() === "discarding" ||
              (!props.configured() && !pending() && !own() && !failure())
            }
            onClick={() => {
              if (failure()) {
                void retry();
                return;
              }
              if (phase() === "recording") {
                void stop();
                return;
              }
              const item = pending();
              const task = own();
              const bound = target();
              if (cancelable() && bound && (task || item)) {
                void discard(bound, task?.operationId ?? item!.operationId);
                return;
              }
              if (item?.status === "succeeded" && bound) {
                void apply(item, task?.key ?? props.key(), bound);
                return;
              }
              void start();
            }}
          >
            <i
              aria-hidden="true"
              class={`assistant-dictation-icon ti ${failure() ? "ti-refresh" : busy() ? "ti-loader-2 k2b-spin" : pending()?.status === "succeeded" ? "ti-check" : "ti-microphone"}`}
            />
            <Show when={cancelable()}>
              <i aria-hidden="true" class="assistant-dictation-trash ti ti-trash" />
            </Show>
          </IconButton>
        }
      >
        <Dropdown.Root
          position="top-left"
          label={t().retry}
          items={[
            { label: t().retry, icon: "ti ti-refresh", action: () => void retry() },
            ...(failure()?.discard
              ? [
                  {
                    label: t().discardDictation,
                    icon: "ti ti-trash",
                    action: () => {
                      void failure()?.discard?.();
                    },
                  },
                ]
              : []),
          ]}
        >
          <Dropdown.Trigger
            appearance="plain"
            class="assistant-dictation-control assistant-dictation-error"
            label={t().retry}
            title={failure()?.message}
          >
            <i class="ti ti-refresh" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    ),
    Status: () => (
      <Show when={pending()?.status === "succeeded" && target() === props.target() && !applying()}>
        <div class="assistant-dictation-ready" role="status">
          <span>{t().ready}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const item = pending();
              const bound = target();
              if (item && bound) void apply(item, props.key(), bound);
            }}
          >
            {t().insert}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const item = pending();
              const bound = target();
              if (item && bound) void discard(bound, item.operationId);
            }}
          >
            {t().discard}
          </Button>
        </div>
      </Show>
    ),
  };
};
