import { Button, InlineGuidance, Paper, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
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
import { type ArtifactSource, hasInterface, LIMITS } from "./contracts";
import { AppFrame, loadAppAssets } from "./html/AppFrame";
import type { AppFrameAssets } from "./html/assets";
import type { AppFiles } from "./html/compose";
import type { Confirm, Mount, MountEvent } from "./html/host";
import { registerLocalRun } from "./local-runs";
import { artifactMessages } from "./messages";
import { runnerClient } from "./runner-client";
import type { RunnerMetadata } from "./runner-contracts";
import type { RuntimeContext } from "./runtime/cloud";
import { CloudError, type CloudErrorCode } from "./runtime/errors";
import { fetchChunk, type RuntimeServices } from "./runtime/services";

type Log = { time: string; level: string; text: string };
type Running = {
  key: number;
  files: AppFiles;
  title: string;
  context: RuntimeContext;
  assets: AppFrameAssets;
  revision: number;
  services: (confirm: Confirm) => RuntimeServices;
};
const RUNTIME = "/api/assistant/artifacts/runtime";
const RUNNER = "/api/assistant/runner";
const filesOf = (source: Pick<ArtifactSource, "files">): AppFiles =>
  Object.fromEntries(source.files.map((file) => [file.path, file.content]));
/**
 * Set while an app starts and cleared once it is ready or stopped: a start that hung the tab does not repeat after a
 * reload. A reload during a slow start therefore shows safe mode once; that costs one click.
 */
const startMarker = (id: string, revision: number) => `assistant-app-starting:${id}:${revision}`;

/**
 * One Studio app in a full surface: the workspace tab, the Apps page, the standalone runner and the
 * editor preview. Apps start on their own only for people who manage them; everyone else presses Start.
 */
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
  /** The editor preview runs these files instead of a saved revision. */
  files?: () => ArtifactSource;
  /** `auto` starts apps the viewer manages; `now` starts because the person asked for it. */
  start?: "auto" | "now";
  /** Mirrors the app's `location.hash` into this page's URL, so reload keeps the view. */
  mirrorHash?: boolean;
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
  const isManager = () => {
    const bundle = metadata();
    return !!bundle && ("canManage" in bundle ? bundle.canManage : bundle.permission === "admin");
  };
  const appInterface = () => {
    const bundle = metadata();
    if (!bundle) return undefined;
    if (props.files) return hasInterface(props.files());
    return "hasInterface" in bundle ? bundle.hasInterface : hasInterface(bundle.source);
  };

  const [running, setRunning] = createSignal<Running>();
  const [loading, setLoading] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal<CloudErrorCode>();
  const [safeMode, setSafeMode] = createSignal(false);
  const [logs, setLogs] = createSignal<Log[]>([]);
  const [consoleOpen, setConsoleOpen] = createSignal(false);
  const consoleId = `artifact-console-${createUniqueId()}`;
  const [activeServerAccess, setActiveServerAccess] = createSignal(props.runner?.serverAccess ?? true);
  let mount: Mount | undefined;
  let marker: string | undefined;
  let generation = 0;
  let runs = 0;
  createEffect(on(error, (failure) => failure && setConsoleOpen(true)));

  const log = (level: string, text: string) =>
    setLogs((current) => [...current, { time: new Date().toISOString(), level, text }].slice(-LIMITS.logs));
  const clearMarker = () => {
    if (marker) sessionStorage.removeItem(marker);
    marker = undefined;
  };
  const stop = async () => {
    generation++;
    setLoading(false);
    clearMarker();
    mount = undefined;
    setRunning(undefined);
    setReady(false);
  };
  onCleanup(() => void stop());
  onMount(() => {
    createEffect(() => {
      onCleanup(registerLocalRun(activeServerAccess() ? props.userId : "public-visitor", props.artifactId, stop));
    });
  });

  // Background checks must never replace a running app with an error boundary.
  let refreshing = false;
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
  if (props.mirrorHash)
    onMount(() => {
      const follow = () => mount?.hash(location.hash);
      window.addEventListener("hashchange", follow);
      onCleanup(() => window.removeEventListener("hashchange", follow));
    });

  const publication = createMemo(() => {
    const bundle = metadata();
    if (!bundle) return { published: false, version: undefined };
    const revision = running()?.revision ?? bundle.sourceRevision;
    if ("serverAccess" in bundle) return { published: true, version: bundle.publishedVersion };
    if (bundle.publishedRevision === revision) return { published: true, version: bundle.publishedVersion };
    return { published: props.version !== undefined, version: props.version };
  });
  async function explainPublication() {
    const revision = running()?.revision ?? metadata()?.sourceRevision;
    if (!isManager() || revision === undefined) return;
    try {
      const { openPublicationInfo } = await import("./publication");
      await openPublicationInfo({
        id: props.artifactId,
        revision,
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

  async function start() {
    await stop();
    const token = generation;
    setLoading(true);
    setError("");
    setNotice(undefined);
    setSafeMode(false);
    setLogs([]);
    try {
      const runner = props.runner ? await runnerClient.app(props.artifactId) : undefined;
      const bundle = runner ? undefined : await artifactClient.get(props.artifactId, props.published, props.version);
      const [context, assets] = await Promise.all([
        runner?.context ?? artifactClient.context(),
        loadAppAssets(props.runner ? RUNNER : RUNTIME),
      ]);
      if (token !== generation) return;
      const serverAccess = runner ? runner.metadata.serverAccess : true;
      if (props.runner && serverAccess && props.userId === "public-visitor") throw new Error(t().runnerUnavailable);
      setActiveServerAccess(serverAccess);
      if (runner) mutate(runner.metadata);
      else if (bundle) mutate(bundle);
      const source = props.files?.() ?? runner ?? bundle!.source;
      if (!hasInterface(source)) throw new Error(t().noInterface);
      const server = serverAccess ? await import("./runtime/browser-server") : undefined;
      if (token !== generation) return;
      const chunk = fetchChunk(props.runner ? RUNNER : RUNTIME);
      const denied = async () => {
        throw new CloudError("denied", t().publicServerUnavailable);
      };
      const revision = runner?.metadata.sourceRevision ?? bundle!.sourceRevision;
      marker = startMarker(props.artifactId, revision);
      sessionStorage.setItem(marker, "1");
      setRunning({
        key: ++runs,
        files: filesOf(source),
        title: runner?.metadata.title ?? bundle!.title,
        context,
        assets,
        revision,
        services: (confirm) =>
          server ? { chunk, ...server.browserServerOptions(props.artifactId, confirm) } : { chunk, database: denied, storage: denied },
      });
    } catch (failure) {
      if (token === generation) setError(failure instanceof Error ? failure.message : t().REQUEST_FAILED);
    } finally {
      if (token === generation) setLoading(false);
    }
  }
  const event = (event: MountEvent) => {
    if (event.type === "ready") {
      setReady(true);
      clearMarker();
    } else if (event.type === "log") log(event.level, event.text);
    else if (event.type === "error") log("error", event.where ? `${event.text} (${event.where})` : event.text);
    else if (event.type === "not-ready") log("error", t().appNotReady({ seconds: event.seconds }));
    else if (event.type === "notice") setNotice(event.code);
    else if (event.type === "stopped" && event.reason !== "request") {
      void stop();
      setError(event.reason === "refusals" ? t().appStoppedRefusals : t().appStoppedFlood);
    }
  };

  // Autostart only for apps the viewer manages, and never twice into a start that froze the tab.
  let decided = false;
  createEffect(() => {
    const bundle = metadata();
    if (decided || !props.start || !bundle || !appInterface()) return;
    decided = true;
    const revision = props.runner ? props.runner.sourceRevision : bundle.sourceRevision;
    if (props.start === "now") void start();
    else if (!isManager()) return;
    else if (sessionStorage.getItem(startMarker(props.artifactId, revision))) setSafeMode(true);
    else void start();
  });

  return (
    <div class="artifact-panel">
      <div class="artifact-panel__preview">
        <Show
          when={running()}
          keyed
          fallback={
            <Show
              when={appInterface() !== false}
              fallback={<Placeholder variant="panel" icon="ti ti-bolt" title={t().noInterface} description={t().noInterfaceHelp} />}
            >
              <Placeholder
                variant="panel"
                icon={metadata()?.icon ?? "ti ti-app-window"}
                title={metadata()?.title}
                description={safeMode() ? t().safeModeHelp : undefined}
                action={
                  <Button loading={loading()} disabled={!metadata()} onClick={() => void start()}>
                    <Show when={!loading()}>
                      <i class="ti ti-player-play" aria-hidden="true" />
                    </Show>
                    {t().start}
                  </Button>
                }
              />
            </Show>
          }
        >
          {(app) => (
            <AppFrame
              files={app.files}
              title={app.title}
              context={app.context}
              assets={app.assets}
              services={app.services}
              hash={props.mirrorHash ? location.hash : undefined}
              onHash={
                props.mirrorHash
                  ? (hash) => history.replaceState(history.state, "", hash || location.pathname + location.search)
                  : undefined
              }
              onEvent={event}
              onMount={(created) => {
                mount = created;
                for (const issue of created.lint)
                  log(issue.severity === "error" ? "error" : "warn", issue.where ? `${issue.message} (${issue.where})` : issue.message);
              }}
            />
          )}
        </Show>
      </div>
      <div class="artifact-panel__console">
        <Show when={notice()}>
          {(code) => (
            <InlineGuidance tone="danger" role="alert">
              {t().appNotice({ code: code() })}
            </InlineGuidance>
          )}
        </Show>
        <Show when={!loading() && running() && (metadata()?.sourceRevision ?? 0) > running()!.revision && !props.files}>
          <InlineGuidance role="status" icon="ti ti-info-circle">
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
            <Show when={appInterface() !== false}>
              <Button
                size="sm"
                variant="ghost"
                disabled={loading()}
                aria-busy={loading() || (running() && !ready()) ? "true" : undefined}
                onClick={() => void start()}
              >
                <i class={`ti ti-refresh${loading() ? " k2b-spin" : ""}`} aria-hidden="true" />
                {t().restart}
              </Button>
              <Button size="sm" variant="ghost" disabled={!loading() && !running()} onClick={() => void stop()}>
                <i class="ti ti-player-stop" aria-hidden="true" />
                {t().stop}
              </Button>
            </Show>
            {props.actions}
          </div>
        </div>
        <Paper id={consoleId} class="artifact-console" hidden={!consoleOpen()}>
          <Show when={running()}>
            <div class="artifact-console__caption">
              {t().console} · {t().revision} {running()!.revision}
            </div>
          </Show>
          <div class="artifact-console__output" aria-live="polite">
            <Show when={error()}>
              <div class="text-red-600" role="alert">
                {error()}
              </div>
            </Show>
            <Show when={logs().length} fallback={<p class="text-muted">{t().noLogs}</p>}>
              <For each={logs()}>
                {(entry) => (
                  <div class="artifact-console__line" data-level={entry.level}>
                    <time dateTime={entry.time}>
                      {new Date(entry.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </time>
                    <StatusBadge
                      class="artifact-console__level"
                      icon={null}
                      tone={
                        entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : entry.level === "info" ? "info" : "neutral"
                      }
                      label={{ error: t().logError, warn: t().logWarning, info: t().logInfo }[entry.level] ?? "Log"}
                    />
                    <span class="artifact-console__message">{entry.text}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Paper>
      </div>
    </div>
  );
}
