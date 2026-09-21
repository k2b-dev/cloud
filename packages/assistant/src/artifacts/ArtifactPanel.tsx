import { files } from "@k2b/stdlib/browser";
import { Button, InlineGuidance, Paper, ScrollArea, StatusBadge, useLocale } from "@k2b/ui";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { artifactClient } from "./client";
import { registerLocalRun } from "./local-runs";
import { artifactMessages } from "./messages";
import { openArtifactModal } from "./modal-host";
import { RuntimeView } from "./RuntimeView";
import { runnerClient } from "./runner-client";
import type { RunnerMetadata } from "./runner-contracts";
import { type ArtifactSession, createArtifactSession, type RunSnapshot } from "./runtime/session";
import { localStorageCall, RuntimeStorage, sharedStorage } from "./runtime/shared-storage";
import { ArtifactStorage } from "./runtime/storage";

export function pickFiles(multiple: boolean, folder: boolean, accept: string, signal: AbortSignal): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.webkitdirectory = folder;
    input.accept = accept;
    input.hidden = true;
    const done = (selected: File[]) => {
      signal.removeEventListener("abort", abort);
      input.remove();
      resolve(selected);
    };
    const abort = () => done([]);
    input.onchange = () => done(Array.from(input.files ?? []));
    input.oncancel = () => done([]);
    if (signal.aborted) return done([]);
    signal.addEventListener("abort", abort, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function ArtifactPanel(props: {
  artifactId: string;
  actions?: JSX.Element;
  runner?: RunnerMetadata;
  onRunnerMetadata?: (metadata: RunnerMetadata) => void;
  onPublished?: () => Promise<void>;
  unsavedChanges?: boolean;
  refreshKey?: string;
  published?: boolean;
  version?: number;
  sourceRevision?: number;
  test?: boolean;
  pickerInputs?: File[];
  autoStart?: boolean;
  userId: string;
  browseSource?: () => void;
  browseVersions?: () => void;
  onTitle?: (title: string) => void;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const loadMetadata = async () =>
    props.runner ? runnerClient.get(props.artifactId) : artifactClient.get(props.artifactId, props.published, props.version);
  const [metadata, { mutate }] = createResource(() => (props.runner ? false : props.artifactId), loadMetadata, {
    initialValue: props.runner,
  });
  createEffect(() => {
    const bundle = metadata();
    if (!bundle) return;
    props.onTitle?.(bundle.title);
    if ("serverAccess" in bundle) props.onRunnerMetadata?.(bundle);
  });
  // Background checks must never replace a running app with an error boundary.
  let refreshing = false;
  const [activeServerAccess, setActiveServerAccess] = createSignal(props.runner?.serverAccess ?? true);
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    const token = generation;
    void loadMetadata()
      .then((bundle) => {
        if (token !== generation) return;
        if (props.runner && "serverAccess" in bundle && bundle.serverAccess !== activeServerAccess()) {
          void stop();
          mutate(bundle);
          setError(t().runnerAccessChanged);
          return;
        }
        mutate(bundle);
      })
      .catch((failure: unknown) => {
        if (
          token === generation &&
          props.runner &&
          failure instanceof Error &&
          "status" in failure &&
          (failure.status === 403 || failure.status === 404)
        ) {
          void stop();
          setError(t().runnerUnavailable);
        }
      })
      .finally(() => {
        refreshing = false;
      });
  };
  createEffect(on(() => props.refreshKey, refresh, { defer: true }));
  onMount(() => {
    const changed = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    window.addEventListener("focus", changed);
    window.addEventListener("assistant-artifact-saved", changed);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("focus", changed);
      window.removeEventListener("assistant-artifact-saved", changed);
    });
  });
  const [state, setState] = createSignal<RunSnapshot>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [consoleOpen, setConsoleOpen] = createSignal(false);
  const consoleId = `artifact-console-${createUniqueId()}`;
  createEffect(
    on(
      () => error() || state()?.error,
      (failure) => {
        if (failure) setConsoleOpen(true);
      },
    ),
  );
  const [revision, setRevision] = createSignal<number>();
  const [runningPublication, setRunningPublication] = createSignal<{ published: boolean; version?: number | null }>();
  const isManager = () => {
    const bundle = metadata();
    return bundle && ("canManage" in bundle ? bundle.canManage : bundle.permission === "admin");
  };
  const publication = createMemo(() => {
    const bundle = metadata();
    if (!bundle) return { published: false, version: undefined };
    const sourceRevision = revision() ?? props.sourceRevision ?? bundle.sourceRevision;
    if ("serverAccess" in bundle) return runningPublication() ?? { published: true, version: bundle.publishedVersion };
    if (bundle.publishedRevision === sourceRevision) return { published: true, version: bundle.publishedVersion };
    return runningPublication() ?? { published: props.version !== undefined, version: props.version };
  });
  async function explainPublication() {
    const sourceRevision = revision() ?? props.sourceRevision ?? metadata()?.sourceRevision;
    if (!isManager() || sourceRevision === undefined) return;
    try {
      const { openPublicationInfo } = await import("./publication");
      await openPublicationInfo({
        id: props.artifactId,
        revision: sourceRevision,
        ...publication(),
        locale: locale(),
        unsavedChanges: props.unsavedChanges,
        onPublished: async () => {
          mutate(await loadMetadata());
          await props.onPublished?.();
          window.dispatchEvent(new Event("assistant-artifact-saved"));
        },
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().REQUEST_FAILED);
    }
  }
  let container!: HTMLDivElement,
    session: ArtifactSession | undefined,
    generation = 0;
  const activeModalId = createMemo(() => (props.test ? state()?.modalId : undefined));
  createEffect(
    on(activeModalId, (modalId) => {
      const request = state()?.modal;
      if (!props.test || !request || !modalId) return;
      const current = session,
        abort = new AbortController();
      void openArtifactModal(request, abort.signal, locale())
        .then((value) => {
          if (!abort.signal.aborted && session === current && state()?.modalId === modalId) current?.respond(value);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e instanceof Error ? e.message : t().REQUEST_FAILED);
        });
      onCleanup(() => abort.abort());
    }),
  );
  const stop = async () => {
    generation++;
    setLoading(false);
    const previous = session;
    session = undefined;
    await previous?.stop();
  };
  onCleanup(() => {
    void stop();
  });
  onMount(() =>
    createEffect(() => {
      onCleanup(registerLocalRun(activeServerAccess() ? props.userId : "public-visitor", props.artifactId, stop));
    }),
  );
  let autoStarted = false;
  createEffect(() => {
    if (props.autoStart && !autoStarted) {
      autoStarted = true;
      void start();
    }
  });
  async function start() {
    const stopping = stop();
    const token = generation;
    await stopping;
    if (token !== generation) return;
    setLoading(true);
    setError("");
    try {
      const loaded = props.runner ? await runnerClient.compiled(props.artifactId) : undefined;
      const bundle = loaded?.metadata ?? (await artifactClient.get(props.artifactId, props.published, props.version));
      if (token !== generation) return;
      const runRevision = props.sourceRevision ?? bundle.sourceRevision;
      const compiled = loaded ?? (await artifactClient.compiled(props.artifactId, runRevision));
      if (token !== generation) return;
      if (!("runtime" in compiled)) throw new Error(t().REQUEST_FAILED);
      mutate(bundle);
      setRevision(runRevision);
      setRunningPublication({
        published: !!loaded || props.version !== undefined || ("publishedRevision" in bundle && bundle.publishedRevision === runRevision),
        version: props.version ?? bundle.publishedVersion,
      });
      const serverAccess = loaded ? loaded.metadata.serverAccess : true;
      if (props.runner && serverAccess && props.userId === "public-visitor") throw new Error(t().runnerUnavailable);
      setActiveServerAccess(serverAccess);
      const server = serverAccess ? (await import("./runtime/browser-server")).browserServerOptions(props.artifactId) : {};
      if (token !== generation) return;
      const storage = new ArtifactStorage(serverAccess ? props.userId : "public-visitor", props.artifactId);
      session = createArtifactSession(container, compiled, {
        mode: props.test ? "test" : "user",
        changed: setState,
        pickerInputs: props.pickerInputs,
        modal: (request, signal) => openArtifactModal(request, signal, locale()),
        ...server,
        storage: (method, args) => {
          if (method !== "storage") return storage.call(method, args);
          const request = RuntimeStorage.parse(args[0]);
          if (request.scope === "shared") {
            if (!serverAccess) throw new Error(t().publicServerUnavailable);
            return sharedStorage(props.artifactId, request);
          }
          const local = localStorageCall(request);
          return storage.call(local.method, local.args);
        },
        pick: pickFiles,
        save: async (file, signal) => {
          if (!signal.aborted) files.downloadFileFromContent(file, file.name, file.type);
        },
      });
    } catch (error) {
      if (token === generation) setError(error instanceof Error ? error.message : t().REQUEST_FAILED);
    } finally {
      if (token === generation) setLoading(false);
    }
  }
  return (
    <div class="artifact-panel">
      <div ref={container} />
      <ScrollArea class="artifact-panel__preview" scrollFade={!!props.runner}>
        <Show
          when={state()?.nodes.length}
          fallback={
            <div class="artifact-panel__launch">
              <Button variant="success" loading={loading()} onClick={() => void start()}>
                <Show when={!loading()}>
                  <i class="ti ti-player-play" aria-hidden="true" />
                </Show>
                {t().start}
              </Button>
            </div>
          }
        >
          <RuntimeView
            nodes={state()?.nodes ?? []}
            busy={state()?.busy || state()?.status === "stopped" || !session}
            event={(event) => {
              void session?.event(event).catch((error) => setError(error instanceof Error ? error.message : t().REQUEST_FAILED));
            }}
          />
        </Show>
      </ScrollArea>
      <div class="artifact-panel__console">
        <Show when={!loading() && revision() !== undefined && (metadata()?.sourceRevision ?? 0) > revision()!}>
          <InlineGuidance role="status" icon="ti ti-info-circle" class="px-2 py-1">
            {t().staleSource}
          </InlineGuidance>
        </Show>
        <div class="artifact-console__header">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={consoleOpen()}
            aria-controls={consoleId}
            onClick={() => setConsoleOpen((value) => !value)}
          >
            <i class="ti ti-terminal-2" aria-hidden="true" />
            {t().console}
            <i class={consoleOpen() ? "ti ti-chevron-down" : "ti ti-chevron-up"} aria-hidden="true" />
          </Button>
          <div class="flex items-center gap-1 flex-wrap justify-end">
            <Show when={isManager()}>
              <Button size="sm" variant="ghost" class="p-0" onClick={() => void explainPublication()}>
                <StatusBadge
                  tone={publication().published ? "neutral" : "warning"}
                  icon={publication().published ? "ti ti-tag" : "ti ti-pencil"}
                  label={
                    publication().published ? `${t().published}${publication().version ? ` · v${publication().version}` : ""}` : t().draft
                  }
                />
              </Button>
            </Show>
            <Show when={props.browseSource}>
              <Button size="sm" variant="ghost" onClick={() => props.browseSource?.()}>
                {t().source}
              </Button>
            </Show>
            <Show when={props.browseVersions}>
              <Button size="sm" variant="ghost" onClick={() => props.browseVersions?.()}>
                <i class="ti ti-git-branch" aria-hidden="true" />
                {t().versions}
              </Button>
            </Show>
            <Button size="sm" variant="ghost" disabled={loading()} aria-busy={loading() ? "true" : undefined} onClick={() => void start()}>
              <i class={`ti ti-refresh${loading() ? " k2b-spin" : ""}`} aria-hidden="true" />
              {t().restart}
            </Button>
            <Button size="sm" variant="ghost" disabled={!loading() && (!state() || state()?.status === "stopped")} onClick={stop}>
              <i class="ti ti-player-stop" aria-hidden="true" />
              {t().stop}
            </Button>
            {props.actions}
          </div>
        </div>
        <Paper id={consoleId} class="artifact-console" hidden={!consoleOpen()}>
          <Show when={revision()}>
            <div class="artifact-console__caption">
              {t().console} · {t().revision} {revision()}
            </div>
          </Show>
          <div class="artifact-console__output" aria-live="polite">
            <Show when={error()}>
              <div class="text-red-600" role="alert">
                {error()}
              </div>
            </Show>
            <Show when={state()?.error && !state()?.logs.some((log) => log.text === state()?.error)}>
              <div class="text-red-600">{state()?.error}</div>
            </Show>
            <Show when={state()?.logs.length} fallback={<p class="text-muted">{t().noLogs}</p>}>
              <For each={state()?.logs}>
                {(log) => (
                  <div class="artifact-console__line" data-level={log.level}>
                    <time dateTime={log.time}>
                      {new Date(log.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </time>
                    <StatusBadge
                      class="artifact-console__level"
                      icon={null}
                      tone={log.level === "error" ? "error" : log.level === "warn" ? "warning" : log.level === "info" ? "info" : "neutral"}
                      label={{ error: t().logError, warn: t().logWarning, info: t().logInfo, debug: "Debug" }[log.level] ?? "Log"}
                    />
                    <span class="artifact-console__message">{log.text === "Started" ? t().started : log.text}</span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={state()?.output !== undefined}>
              <pre>{JSON.stringify(state()?.output, null, 2)}</pre>
            </Show>
            <Show when={props.test}>
              <For each={state()?.files}>
                {(file) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const value = session?.files().find((output) => output.name === file.name);
                      if (value) files.downloadFileFromContent(value, value.name, value.type);
                    }}
                  >
                    <i class="ti ti-download" />
                    {file.name}
                  </Button>
                )}
              </For>
            </Show>
          </div>
        </Paper>
      </div>
    </div>
  );
}
