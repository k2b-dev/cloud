import { Button, Paper, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import { createEffect, createResource, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { openArtifactModal } from "./modal-host";
import { RuntimeView } from "./RuntimeView";
import { createArtifactSession, type ArtifactSession, type RunSnapshot } from "./runtime/session";
import { ArtifactStorage } from "./runtime/storage";

function pickFiles(multiple: boolean, folder: boolean, accept: string, signal: AbortSignal): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = multiple; input.webkitdirectory = folder; input.accept = accept; input.hidden = true;
    const done = (selected: File[]) => { signal.removeEventListener("abort", abort); input.remove(); resolve(selected); };
    const abort = () => done([]);
    input.onchange = () => done(Array.from(input.files ?? []));
    input.oncancel = () => done([]);
    if (signal.aborted) return done([]);
    signal.addEventListener("abort", abort, { once: true });
    document.body.append(input); input.click();
  });
}

export function ArtifactPanel(props: { artifactId: string; refreshKey?: string; userId: string; browseSource: () => void; onTitle?: (title: string) => void }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const [metadata, { mutate }] = createResource(() => props.artifactId, artifactClient.get);
  createEffect(() => { if (metadata()) props.onTitle?.(metadata()!.title); });
  // Background checks must never replace a running app with an error boundary.
  const refresh = () => { void artifactClient.get(props.artifactId).then(bundle => {
    if (bundle.revision > (metadata()?.revision ?? 0)) mutate(bundle);
  }).catch(() => {}); };
  createEffect(on(() => props.refreshKey, refresh, { defer: true }));
  onMount(() => {
    const changed = () => refresh();
    window.addEventListener("focus", changed);
    window.addEventListener("assistant-artifact-saved", changed);
    onCleanup(() => {
      window.removeEventListener("focus", changed);
      window.removeEventListener("assistant-artifact-saved", changed);
    });
  });
  const [state, setState] = createSignal<RunSnapshot>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [consoleOpen, setConsoleOpen] = createSignal(false);
  const consoleId = `artifact-console-${createUniqueId()}`;
  createEffect(on(() => error() || state()?.error, (failure) => { if (failure) setConsoleOpen(true); }));
  const [revision, setRevision] = createSignal<number>();
  let container!: HTMLDivElement, session: ArtifactSession | undefined, generation = 0;
  const stop = () => { generation++; setLoading(false); void session?.stop(); session = undefined; };
  onCleanup(stop);
  async function start() {
    stop();
    const token = generation;
    setLoading(true); setError("");
    try {
      const bundle = await artifactClient.get(props.artifactId);
      if (token !== generation) return;
      const compiled = await artifactClient.compiled(props.artifactId, bundle.revision);
      if (token !== generation) return;
      if (!("runtime" in compiled)) throw new Error(t().REQUEST_FAILED);
      mutate(bundle);
      setRevision(bundle.revision);
      const storage = new ArtifactStorage(props.userId, props.artifactId);
      session = createArtifactSession(container, compiled, {
        mode: "user", changed: setState,
        modal: (request, signal) => openArtifactModal(request, signal, locale()),
        storage: (method, args) => storage.call(method, args),
        pick: pickFiles,
        save: async (file, signal) => { if (!signal.aborted) files.downloadFileFromContent(file, file.name, file.type); },
      });
    } catch (error) {
      if (token === generation) setError(error instanceof Error ? error.message : t().REQUEST_FAILED);
    } finally { if (token === generation) setLoading(false); }
  }
  return <div class="artifact-panel">
    <div ref={container} />
    <div class="artifact-panel__preview">
      <Show when={state()?.nodes.length} fallback={<div class="artifact-panel__launch">
        <Button variant="success" loading={loading()} onClick={() => void start()}><Show when={!loading()}><i class="ti ti-player-play" aria-hidden="true" /></Show>{t().start}</Button>
      </div>}>
        <RuntimeView nodes={state()?.nodes ?? []} busy={state()?.busy || state()?.status === "stopped" || !session} event={(event) => {
          void session?.event(event).catch((error) => setError(error instanceof Error ? error.message : t().REQUEST_FAILED));
        }} />
      </Show>
    </div>
    <Show when={revision() !== undefined && (metadata()?.revision ?? 0) > revision()!}>
      <div role="status" class="flex items-center gap-2">
        <span class="text-sm text-muted">{t().staleSource}</span>
      </div>
    </Show>
    <div class="artifact-console__header">
        <Button size="sm" variant="ghost" aria-expanded={consoleOpen()} aria-controls={consoleId} onClick={() => setConsoleOpen(value => !value)}>
          <i class="ti ti-terminal-2" aria-hidden="true" />{t().console}
          <i class={consoleOpen() ? "ti ti-chevron-down" : "ti ti-chevron-up"} aria-hidden="true" />
        </Button>
        <div class="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => props.browseSource()}>{t().source}</Button>
          <Button size="sm" variant="ghost" disabled={loading()} aria-busy={loading() ? "true" : undefined} onClick={() => void start()}><i class={`ti ti-refresh${loading() ? " k2b-spin" : ""}`} aria-hidden="true" />{t().restart}</Button>
          <Button size="sm" variant="ghost" disabled={!loading() && (!state() || state()?.status === "stopped")} onClick={stop}><i class="ti ti-player-stop" aria-hidden="true" />{t().stop}</Button>
        </div>
      </div>
    <Paper id={consoleId} class="artifact-console" hidden={!consoleOpen()}>
      <Show when={revision()}><small class="text-muted">{t().runningRevision} {revision()}</small></Show>
      <div class="artifact-console__output" aria-live="polite">
        <Show when={error()}><div class="text-red-600" role="alert">{error()}</div></Show>
        <Show when={state()?.error && !state()?.logs.some((log) => log.text === state()?.error)}><div class="text-red-600">{state()?.error}</div></Show>
        <Show when={state()?.logs.length} fallback={<p class="text-muted">{t().noLogs}</p>}>
          <For each={state()?.logs}>{(log) => <div class="artifact-console__line" data-level={log.level}>
            <time>{new Date(log.time).toLocaleTimeString(locale())}</time>
            <span class="artifact-console__level">{{ error: "err", warn: "wrn", info: "inf" }[log.level] ?? "log"}:</span>
            <span>{log.text === "Started" ? t().started : log.text}</span>
          </div>}</For>
        </Show>
        <Show when={state()?.output !== undefined}><pre>{JSON.stringify(state()?.output, null, 2)}</pre></Show>
      </div>
    </Paper>
  </div>;
}
