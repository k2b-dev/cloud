import { ErrorBoundary, createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import { ChatPresentation as PresentationSchema, ChatPresentationResult } from "./chat-presentation-contracts";
import { artifactClient } from "./client";
import { createArtifactSession, type ArtifactSession, type RunSnapshot } from "./runtime/session";
import { artifactMessages } from "./messages";
import { pickFiles } from "./ArtifactPanel";
import { RuntimeView } from "./RuntimeView";
import { presentationHtml, presentationChartSvg } from "./presentation-export";
import { runCapability } from "./runtime/capabilities";
import { approveInModal } from "./CapabilityApproval";
import { openArtifactModal } from "./modal-host";
import { runHttp, type HttpHost } from "./http-host";

export function ChatPresentation(props: { result: unknown; conversationId: string; httpHost: HttpHost }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [downloading, setDownloading] = createSignal(false);
  const [state, setState] = createSignal<RunSnapshot>();
  const [active, setActive] = createSignal(false);
  const descriptor = () => ChatPresentationResult.safeParse(props.result);
  const abort = new AbortController();
  const [data] = createResource(() => {
    const result = descriptor();
    return result.success ? `${props.conversationId}/${result.data.presentationId}` : false;
  }, async () => {
    const result = ChatPresentationResult.parse(props.result);
    const response = await fetch(`/api/assistant/artifacts/presentations/${result.presentationId}?${new URLSearchParams({ conversationId: props.conversationId })}`, { signal: abort.signal });
    if (!response.ok) throw new Error(t().visualizationLoadFailed);
    return PresentationSchema.parse(await response.json());
  });
  let session: ArtifactSession | undefined;
  let container!: HTMLDivElement;
  let generation = 0;
  const stop = () => { generation++; void session?.stop(); session = undefined; setActive(false); setLoading(false); };
  onCleanup(() => { abort.abort(); stop(); });
  // A conversation switch must never retain executable state from another chat.
  createEffect(() => { props.conversationId; stop(); setState(undefined); });
  const unsettled = () => Boolean(loading() || (active() && (state()?.status !== "ready" || state()?.busy || state()?.pendingRequests || state()?.inputPending || state()?.approvalPending || state()?.work?.status === "running")));
  const nodes = () => state()?.nodes.length ? state()!.nodes : data()?.nodes ?? [];
  const preview = () => {
    try { return { html: presentationHtml(nodes(), data()?.title ?? "", locale()), error: "" }; }
    catch (error) { return { html: "", error: String(error) }; }
  };
  async function start() {
    stop();
    const token = generation;
    setError(""); setLoading(true); setState(undefined);
    try {
      const saved = data();
      if (!saved) throw new Error(t().visualizationUnavailable);
      const compiled = await artifactClient.compile({ entry: "main.ts", files: [{ path: "main.ts", content: saved.code }] });
      if (abort.signal.aborted || token !== generation) return;
      session = createArtifactSession(container, compiled, {
        mode: "user", changed: value => { if (token === generation) setState(value); },
        inputFiles: saved.inputs.map(input => ({ name: input.path, size: input.size, type: input.mediaType })),
        readInput: async (path, signal) => {
          const response = await fetch(`/api/assistant/artifacts/presentations/${saved.id}/input?${new URLSearchParams({ conversationId: props.conversationId, path })}`, { signal });
          if (!response.ok) throw new Error(t().visualizationInputUnavailable);
          const file = new File([await response.blob()], path.split("/").pop()!, { type: response.headers.get("Content-Type") ?? "" });
          Object.defineProperty(file, "webkitRelativePath", { value: path });
          return file;
        },
        pick: pickFiles,
        modal: (request, signal) => openArtifactModal(request, signal, locale()),
        capability: (name, input, signal) => runCapability(name, input, { conversationId: props.conversationId }, approveInModal, signal),
        http: (request, signal) => runHttp(request, { conversationId: props.conversationId }, props.httpHost, signal),
        pdf: (request, signal) => artifactClient.pdf(request, { conversationId: props.conversationId }, signal),
        save: async (file, signal) => { if (!signal.aborted) files.downloadFileFromContent(file, file.name, file.type); },
      });
      setActive(true);
    } catch (error) { if (token === generation) setError(String(error)); }
    finally { if (token === generation) setLoading(false); }
  }
  async function download(format: "html" | "pdf", nodeId?: string) {
    if (unsettled() || downloading()) return;
    setError(""); setDownloading(true);
    try {
      const title = data()?.title ?? t().visualization;
      const node = nodes().find(node => node.id === nodeId);
      const content = node ? presentationChartSvg(node, locale()) : presentationHtml(nodes(), title, locale());
      const blob = node ? new Blob([content], { type: "image/svg+xml" }) : format === "pdf"
        ? await artifactClient.pdf({ operation: "render", html: content }, { conversationId: props.conversationId }, abort.signal)
        : new Blob([content], { type: "text/html" });
      if (!abort.signal.aborted) files.downloadFileFromContent(blob, `${title}.${node ? "svg" : format}`, blob.type);
    } catch (error) { if (!abort.signal.aborted) setError(String(error)); }
    finally { setDownloading(false); }
  }
  return <ErrorBoundary fallback={error => <NoticeCard tone="danger" title={t().visualizationUnavailable} detail={String(error)} />}><section class="assistant-chat-presentation" aria-label={descriptor().success ? ChatPresentationResult.parse(props.result).title : t().visualization}>
    <div ref={container} />
    <Show when={data()} fallback={<p role="status">{!descriptor().success ? t().visualizationInvalid : data.error ? String(data.error) : t().visualizationLoading}</p>}>
      <header><strong>{data()?.title}</strong><Button variant="ghost" loading={loading()} onClick={() => active() ? stop() : void start()}>{active() ? t().stop : t().visualizationInteract}</Button></header>
      <Show when={active()} fallback={<Show when={!preview().error} fallback={<NoticeCard tone="warning" title={t().visualization} detail={preview().error} />}><iframe title={data()?.title} sandbox="" srcdoc={preview().html} class="assistant-chat-presentation__preview" /></Show>}>
        <RuntimeView nodes={nodes()} busy={Boolean(state()?.busy || state()?.status !== "ready")} event={event => { void session?.event(event).catch(error => setError(String(error))); }} />
      </Show>
      <footer>
        <Button variant="ghost" loading={downloading()} disabled={unsettled()} onClick={() => void download("pdf")}>PDF</Button>
        <Button variant="ghost" disabled={downloading() || unsettled()} onClick={() => void download("html")}>HTML</Button>
        <For each={nodes().filter(node => node.type === "chart" || node.type === "explorer")}>
          {node => <Button variant="ghost" disabled={downloading() || unsettled()} onClick={() => void download("html", node.id)}>SVG · {node.label || node.id}</Button>}
        </For>
      </footer>
    </Show>
    <Show when={error() || state()?.error}><NoticeCard tone="danger" title={t().visualization} detail={error() || state()?.error} /></Show>
  </section></ErrorBoundary>;
}
