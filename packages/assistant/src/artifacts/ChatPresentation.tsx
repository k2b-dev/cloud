import { Button, Dropdown, IconButton, InlineGuidance, Placeholder, useLocale } from "@k2b/ui";
import { createEffect, createResource, createSignal, ErrorBoundary, on, onCleanup, Show } from "solid-js";
import { approveInModal } from "./CapabilityApproval";
import { ChatPresentationResult, ChatPresentation as PresentationSchema } from "./chat-presentation-contracts";
import { artifactClient } from "./client";
import { AppFrame, loadAppAssets } from "./html/AppFrame";
import type { AppFrameAssets } from "./html/assets";
import type { AppFiles } from "./html/compose";
import { type Confirm, type Mount, saveDownload } from "./html/host";
import { type HttpHost, runHttp } from "./http-host";
import { artifactMessages } from "./messages";
import type { RuntimeContext } from "./runtime/cloud";
import { runCapability } from "./runtime/capabilities";
import type { RuntimeServices } from "./runtime/services";

type Running = {
  files: AppFiles;
  context: RuntimeContext;
  assets: AppFrameAssets;
  services: (confirm: Confirm) => RuntimeServices;
};

/**
 * An HTML app in the chat: one-off files without saved data, or a saved app with its data. It starts on a
 * click, never while scrolling past, and keeps a fixed height so nothing below it moves.
 * `result` is undefined while its `code_present` call runs; the card is reserved meanwhile.
 */
export function ChatPresentation(props: {
  result: unknown;
  conversationId: string;
  httpHost: HttpHost;
  /** Opens a saved app beside the chat. */
  openApp?: (id: string, title: string) => void;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const descriptor = () => ChatPresentationResult.safeParse(props.result);
  const abort = new AbortController();
  const [data] = createResource(
    () => {
      const result = descriptor();
      return result.success ? `${props.conversationId}/${result.data.presentationId}` : false;
    },
    async () => {
      const result = ChatPresentationResult.parse(props.result);
      const response = await fetch(
        `/api/assistant/artifacts/presentations/${result.presentationId}?${new URLSearchParams({ conversationId: props.conversationId })}`,
        { signal: abort.signal },
      );
      if (!response.ok) throw new Error(t().visualizationLoadFailed);
      return PresentationSchema.parse(await response.json());
    },
  );
  const title = () => data()?.title ?? (descriptor().success ? ChatPresentationResult.parse(props.result).title : t().visualization);
  const [running, setRunning] = createSignal<Running>();
  const [loading, setLoading] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [downloading, setDownloading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let mount: Mount | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    mount = undefined;
    setRunning(undefined);
    setReady(false);
    setLoading(false);
    setNotice("");
  };
  onCleanup(() => {
    abort.abort();
    stop();
  });
  // A conversation switch must never retain executable state from another chat.
  createEffect(on(() => props.conversationId, stop, { defer: true }));

  async function start() {
    stop();
    const token = generation;
    const saved = data();
    if (!saved) return;
    setError("");
    setLoading(true);
    try {
      const scope = { conversationId: props.conversationId };
      const [files, context, assets, server] = await Promise.all([
        saved.files ??
          artifactClient.get(saved.artifactId!).then((app) => {
            if (!app.source.files.some((file) => file.path === "index.html")) throw new Error(t().noInterface);
            return app.source.files;
          }),
        artifactClient.context(),
        loadAppAssets("/api/assistant/artifacts/runtime"),
        saved.artifactId ? import("./runtime/browser-server") : undefined,
      ]);
      if (token !== generation) return;
      setRunning({
        files: Object.fromEntries(files.map((file) => [file.path, file.content])),
        context,
        assets,
        services: (confirm) =>
          server && saved.artifactId
            ? server.browserServerOptions(saved.artifactId, confirm)
            : {
                ai: (request, signal) => artifactClient.ai(request, scope, signal),
                pdf: (request, signal) => artifactClient.pdf(request, scope, signal),
                capability: (name, input, signal) =>
                  runCapability(
                    name,
                    input,
                    scope,
                    (request, signal) => confirm(() => approveInModal(request, signal), (decision) => decision.approved),
                    signal,
                  ),
                http: (request, signal) =>
                  runHttp(
                    request,
                    scope,
                    { ...props.httpHost, approve: (review, signal) => confirm(() => props.httpHost.approve(review, signal), (ok) => ok) },
                    signal,
                  ),
              },
      });
    } catch (failure) {
      if (token === generation) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === generation) setLoading(false);
    }
  }
  async function download(format: "html" | "pdf") {
    if (!mount || downloading()) return;
    setDownloading(true);
    try {
      const html = await mount.snapshot();
      const file =
        format === "pdf"
          ? await artifactClient.pdf({ operation: "render", html }, { conversationId: props.conversationId }, abort.signal)
          : new Blob([html], { type: "text/html" });
      if (!abort.signal.aborted) saveDownload(`${title()}.${format}`, file);
    } catch (failure) {
      if (!abort.signal.aborted) setNotice(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <ErrorBoundary fallback={(failure) => <Placeholder state="error" title={t().visualizationUnavailable} description={String(failure)} />}>
      <section
        data-presentation-id={descriptor().success ? ChatPresentationResult.parse(props.result).presentationId : undefined}
        class="assistant-chat-presentation"
        aria-label={title()}
        aria-busy={props.result === undefined ? "true" : undefined}
      >
        <header class="assistant-chat-presentation__header">
          <i class="ti ti-layout-dashboard assistant-chat-presentation__icon" aria-hidden="true" />
          <strong>{title()}</strong>
          <small>{t().studioApp}</small>
          <div class="assistant-chat-presentation__actions">
            <Show when={running()}>
              <Dropdown.Root
                position="bottom-right"
                items={(["pdf", "html"] as const).map((format) => ({
                  label: format.toUpperCase(),
                  icon: `ti ti-file-type-${format}`,
                  disabled: !ready() || downloading(),
                  action: () => void download(format),
                }))}
              >
                <Dropdown.Trigger variant="ghost" iconOnly label={t().visualizationDownloads} loading={downloading()}>
                  <i class="ti ti-download" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
              <IconButton size="sm" label={t().stop} onClick={stop}>
                <i class="ti ti-player-stop" aria-hidden="true" />
              </IconButton>
            </Show>
            <Show when={props.openApp && data()?.artifactId}>
              {(id) => (
                <Button size="sm" variant="ghost" onClick={() => props.openApp?.(id(), title())}>
                  <i class="ti ti-arrows-maximize" aria-hidden="true" />
                  {t().open}
                </Button>
              )}
            </Show>
          </div>
        </header>
        <div class="assistant-chat-presentation__body">
          <Show
            when={running()}
            keyed
            fallback={
              <Show
                when={data()}
                fallback={
                  <Placeholder
                    variant="panel"
                    state={data.error || (props.result !== undefined && !descriptor().success) ? "error" : "loading"}
                    title={
                      props.result !== undefined && !descriptor().success
                        ? t().visualizationInvalid
                        : data.error
                          ? t().visualizationLoadFailed
                          : undefined
                    }
                  />
                }
              >
                <Placeholder
                  variant="panel"
                  state={error() ? "error" : "empty"}
                  title={error() ? t().visualizationUnavailable : undefined}
                  description={error() || undefined}
                  action={
                    <Button loading={loading()} onClick={() => void start()}>
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
                title={title()}
                context={app.context}
                assets={app.assets}
                services={app.services}
                onMount={(created) => {
                  mount = created;
                }}
                onEvent={(event) => {
                  if (event.type === "ready") setReady(true);
                  else if (event.type === "notice") setNotice(t().appNotice({ message: event.text }));
                  else if (event.type === "stopped" && event.reason !== "Stopped") {
                    stop();
                    setError(event.reason);
                  }
                }}
              />
            )}
          </Show>
          <Show when={notice()}>
            <InlineGuidance class="assistant-chat-presentation__notice" tone="danger" role="alert">
              {notice()}
            </InlineGuidance>
          </Show>
        </div>
      </section>
    </ErrorBoundary>
  );
}
