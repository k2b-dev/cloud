import { query } from "@k2b/stdlib/solid";
import { Button, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { audioMessages } from "./audio-messages";
import { startAudioRecording } from "./audio-recorder";
import { type AssistantLiveInvalidation, createAssistantLiveInvalidationHub, matchesAssistantInvalidation } from "./assistant-live";

type Dictation = {
  id: string;
  sourcePath: string;
  operationId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  disposition: "pending" | "applied" | "discarded";
  text?: string | null;
};
const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/ai${path}`, init);
  if (!response.ok) throw new Error(`Audio request failed (${response.status}).`);
  return response.json();
};
const endpoint = (target: string, id?: string) => `/conversations/${target}/dictations${id ? `/${id}` : ""}`;

export const createAssistantDictation = (props: {
  configured: () => boolean;
  key: () => string;
  target: () => string | null;
  ensureTarget: () => Promise<{ key: string; target: string } | null>;
  generation: (key: string) => number;
  live: ReturnType<typeof createAssistantLiveInvalidationHub>;
  apply: (key: string, target: string, id: string) => Promise<boolean>;
  onError: (message: string) => void;
}) => {
  const locale = useLocale();
  const t = () => audioMessages.resolve([locale()]).t;
  const [phase, setPhase] = createSignal<"idle" | "starting" | "recording" | "uploading" | "upload-failed">("idle");
  const [applying, setApplying] = createSignal(false);
  const [preview, setPreview] = createSignal<Dictation | null>(null);
  let recording: Awaited<ReturnType<typeof startAudioRecording>> | undefined;
  let own: { key: string; target: string; generation: number; operationId: string; id?: string; blob?: Blob; auto: boolean } | undefined;
  let disposed = false;
  const list = query.create<string | null, { target: string | null; items: Dictation[] }, AssistantLiveInvalidation>({
    source: props.target,
    load: async (target, { abortSignal }) => {
      if (!target) return { target, items: [] };
      const all: Dictation[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Dictation[]; nextCursor: string | null } = await request(
          `${endpoint(target)}${cursor ? `?after=${cursor}` : ""}`,
          { signal: abortSignal },
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return { target, items: all };
    },
  });
  const items = () => (list.data()?.target === props.target() ? (list.data()?.items ?? []) : []);
  createEffect(() => {
    props.target();
    setPreview(null);
  });
  createEffect(() => {
    const pending = items();
    if (!own || own.id || phase() !== "upload-failed") return;
    const recovered = pending.find((item) => item.operationId === own?.operationId);
    if (recovered) {
      own.id = recovered.id;
      own.blob = undefined;
      setPhase("idle");
    }
  });
  const unregister = props.live.register({
    matches: (event) =>
      Boolean(props.target()) && matchesAssistantInvalidation(["conversation-dictations"], { conversationId: props.target()! })(event),
    invalidate: (event) => list.invalidate(event),
  });
  const apply = async (item: Dictation, automatic = false) => {
    const target = props.target();
    if (!target || applying()) return;
    const key = props.key();
    if (automatic && (!own || !own.auto || own.id !== item.id || own.key !== key || own.generation !== props.generation(key))) return;
    if (own) own.auto = false;
    setApplying(true);
    try {
      if (await props.apply(key, target, item.id)) {
        setPreview(null);
        await list.refresh();
      }
    } catch (error) {
      props.onError(error instanceof Error ? error.message : t().failed);
    } finally {
      setApplying(false);
    }
  };
  createEffect(() => {
    const pending = items();
    if (!own?.auto || own.key !== props.key()) return;
    const item = pending.find((entry) => entry.id === own?.id && entry.status === "succeeded");
    if (item) void apply(item, true);
  });
  const upload = async () => {
    const task = own;
    if (!task?.blob || phase() === "uploading") return;
    setPhase("uploading");
    try {
      const form = new FormData();
      form.append("operationId", task.operationId);
      form.append("file", task.blob, "dictation.wav");
      const item = await request<Dictation>(endpoint(task.target), { method: "POST", body: form });
      task.id = item.id;
      task.blob = undefined;
      setPhase("idle");
      // Also reload when completion arrived before query registration or the start response.
      await list.refresh();
    } catch {
      if (!disposed) {
        setPhase("upload-failed");
        props.onError(t().uploadFailed);
      }
    }
  };
  const stop = async () => {
    if (!recording || !own || phase() !== "recording") return;
    const current = recording;
    recording = undefined;
    setPhase("uploading");
    try {
      own.blob = await current.stop();
      setPhase("idle");
      await upload();
    } catch {
      setPhase("idle");
      props.onError(t().recordFailed);
    }
  };
  const start = async () => {
    if (!props.configured() || phase() !== "idle" || items().length) return;
    setPhase("starting");
    try {
      const bound = await props.ensureTarget();
      if (!bound || disposed) {
        setPhase("idle");
        return;
      }
      own = { ...bound, generation: props.generation(bound.key), operationId: crypto.randomUUID(), auto: true };
      const next = await startAudioRecording(() => void stop());
      if (disposed || props.key() !== bound.key) {
        next.discard();
        setPhase("idle");
        return;
      }
      recording = next;
      setPhase("recording");
    } catch {
      setPhase("idle");
      props.onError(t().recordFailed);
    }
  };
  createEffect(() => {
    const key = props.key();
    if (own && key !== own.key) {
      own.auto = false;
      if (phase() === "recording") void stop();
    }
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (phase() !== "idle") {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => {
    disposed = true;
    recording?.discard();
    unregister();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnload);
  });
  const action = async (item: Dictation, action: "retry" | "discard") => {
    const target = props.target();
    if (!target) return;
    try {
      await request(`${endpoint(target, item.id)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setPreview(null);
      await list.refresh();
    } catch {
      props.onError(t().failed);
    }
  };
  return {
    busy: () => phase() !== "idle" || applying(),
    invalidateAutomatic: () => {
      if (own) own.auto = false;
    },
    Control: () => (
      <Button
        size="sm"
        variant="ghost"
        disabled={
          !props.configured() || (phase() !== "idle" && phase() !== "recording") || (phase() !== "recording" && Boolean(items().length))
        }
        title={!props.configured() ? t().microphoneUnavailable : undefined}
        onClick={() => (phase() === "recording" ? void stop() : void start())}
      >
        <i class={phase() === "recording" ? "ti ti-player-stop" : "ti ti-microphone"} />
        {phase() === "recording" ? t().stop : t().dictate}
      </Button>
    ),
    Status: () => (
      <div aria-live="polite">
        <Show when={phase() === "starting" || phase() === "uploading"}>
          <p>{phase() === "starting" ? t().starting : t().uploading}</p>
        </Show>
        <Show when={phase() === "upload-failed"}>
          <p>{t().uploadFailed}</p>
          <Button size="sm" onClick={() => void upload()}>
            {t().retry}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              own = undefined;
              setPhase("idle");
            }}
          >
            {t().discard}
          </Button>
        </Show>
        <Show when={list.error()}>
          <Button size="sm" variant="ghost" onClick={() => void list.refresh()}>
            {t().retry}
          </Button>
        </Show>
        <For each={items()}>
          {(item) => (
            <div class="flex flex-wrap items-center gap-2 py-2">
              <span>{item.status === "succeeded" ? t().ready : item.status === "failed" ? t().failed : t().processing}</span>
              <Show when={item.status === "succeeded"}>
                <Button size="sm" disabled={applying()} onClick={() => void apply(item)}>
                  {t().insert}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const target = props.target();
                    if (target) {
                      try {
                        setPreview(await request(endpoint(target, item.id)));
                      } catch {
                        props.onError(t().failed);
                      }
                    }
                  }}
                >
                  {t().preview}
                </Button>
              </Show>
              <Show when={item.status === "failed"}>
                <Button size="sm" onClick={() => void action(item, "retry")}>
                  {t().retry}
                </Button>
              </Show>
              <Button size="sm" variant="ghost" disabled={applying()} onClick={() => void action(item, "discard")}>
                {t().discard}
              </Button>
            </div>
          )}
        </For>
        <Show when={preview()}>
          {(item) => <pre class="max-h-64 overflow-auto whitespace-pre-wrap text-sm">{item().text || t().noSpeech}</pre>}
        </Show>
      </div>
    ),
  };
};
