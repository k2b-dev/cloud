import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { resolveUiMessages, useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";

export type PdfPreviewRequest = () => Promise<Response | Blob>;

export type PdfPreviewProps = {
  request: PdfPreviewRequest;
  autoLoad?: boolean;
  disabled?: () => boolean;
  title?: string;
  buttonLabel?: string;
  openButtonLabel?: string;
  /**
   * Opens the document at this address in a new tab instead of a local copy. Pass a stable same-origin URL that
   * serves the PDF inline, so reloading and the viewer's file name keep working. Without it, the open action shows
   * a temporary copy of the requested document.
   */
  openHref?: string;
  /** Adds a Download action. The host owns the download, for example a fresh attachment URL. */
  onDownload?: () => void;
  emptyText?: string;
  class?: string;
  children?: (parts: { actions: JSX.Element; content: JSX.Element }) => JSX.Element;
  renderError?: (message: string) => JSX.Element;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as unknown;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  } catch {
    // Fall through to the HTTP status fallback.
  }
  return resolveUiMessages().pdfPreviewHttpError({ status: response.status });
};

export default function PdfPreview(props: PdfPreviewProps) {
  const messages = useUiMessages();
  const [url, setUrl] = createSignal<string | null>(null);
  // An automatic preview starts loading once mounted. The server and the page before hydration already show that
  // state, so they offer neither a retry nor an invitation to render while nothing has failed.
  const [loading, setLoading] = createSignal(Boolean(props.autoLoad) && !props.disabled?.());
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [tabBlocked, setTabBlocked] = createSignal(false);
  // The frame has its document only once it fires `load`; until then the loading state covers it.
  const [drawn, setDrawn] = createSignal(false);
  // An automatic preview shows one fixed document; the open action reuses it instead of requesting it again.
  let shownBlob: Blob | null = null;
  let openButton: HTMLElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let viewer: HTMLDivElement | undefined;
  let renderButton: HTMLButtonElement | undefined;
  let errorRetryButton: HTMLButtonElement | undefined;
  let disposed = false;
  let loadGeneration = 0;
  let openGeneration = 0;

  const revokeCurrent = () => {
    const current = url();
    if (current) URL.revokeObjectURL(current);
    setUrl(null);
  };

  onCleanup(() => {
    disposed = true;
    loadGeneration += 1;
    openGeneration += 1;
    revokeCurrent();
  });

  const readPdfBlob = async () => {
    const response = await props.request();
    const blob = response instanceof Response ? (response.ok ? await response.blob() : null) : response;
    if (!blob) throw new Error(await readErrorMessage(response as Response));
    if (blob.type && blob.type !== "application/pdf") throw new Error(`PDF preview returned ${blob.type} instead of application/pdf`);
    return blob;
  };

  const load = async () => {
    if (loading() || opening() || props.disabled?.()) return;
    const generation = ++loadGeneration;
    // A retry the shown document or the loading state removes hands keyboard focus on instead of dropping it.
    const retryFocused =
      (props.autoLoad && document.activeElement === renderButton) ||
      (errorRetryButton?.isConnected && document.activeElement === errorRetryButton);
    setLoading(true);
    setError(null);
    try {
      const blob = await readPdfBlob();
      const nextUrl = URL.createObjectURL(blob);
      if (disposed || generation !== loadGeneration) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      const previousUrl = url();
      shownBlob = blob;
      setFailed(false);
      setDrawn(false);
      setUrl(nextUrl);
      setLoading(false);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      // The shown document removes the retry action; keep keyboard focus in the actions instead of the page, or on the
      // document itself, or the hint in its place, when the host shows only the content.
      if (retryFocused && document.activeElement === document.body)
        (openButton?.isConnected ? openButton : frame?.isConnected ? frame : viewer)?.focus();
    } catch (e) {
      if (disposed || generation !== loadGeneration) return;
      shownBlob = null;
      setFailed(true);
      setError(e instanceof Error ? e.message : "PDF preview failed");
      if (retryFocused && document.activeElement === document.body) errorRetryButton?.focus();
    } finally {
      if (!disposed && generation === loadGeneration) setLoading(false);
    }
  };

  onMount(() => {
    // Hand the initial loading state to the request itself, which also covers a preview disabled by now.
    setLoading(false);
    if (props.autoLoad) void load();
  });

  const openInNewTab = async () => {
    if (loading() || opening() || props.disabled?.()) return;
    const generation = ++openGeneration;
    const tab = window.open("", "_blank");
    // A blocked tab is not a document error: keep the shown document and report it beside the actions.
    setTabBlocked(!tab);
    if (!tab) return;
    tab.opener = null;
    tab.document.title = props.title ?? messages().pdfPreview;
    tab.document.body.textContent = messages().pdfPreviewRendering;
    setOpening(true);
    setError(null);
    try {
      const blob = (props.autoLoad ? shownBlob : null) ?? (await readPdfBlob());
      if (disposed || generation !== openGeneration) {
        tab.close();
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      tab.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e) {
      tab.close();
      if (!disposed && generation === openGeneration) setError(e instanceof Error ? e.message : "PDF preview failed");
    } finally {
      if (!disposed && generation === openGeneration) setOpening(false);
    }
  };

  // With autoLoad, rendering again would show the same document: offer it only until one is shown. After a failure the
  // default error state carries it as the retry; beside a caller's error content it stays in place while a retry loads.
  const renderable = () => !props.autoLoad || (failed() ? Boolean(props.renderError) : !url() && !loading());
  const actions = () => (
    <div class="k2b-content-pdf-preview__actions">
      <Show
        when={!props.disabled?.() && props.openHref}
        fallback={
          <button
            ref={(element) => (openButton = element)}
            type="button"
            class="k2b-button"
            data-variant="secondary"
            data-size="sm"
            onClick={() => void openInNewTab()}
            disabled={loading() || opening() || props.disabled?.()}
          >
            <i class={opening() ? "ti ti-loader-2 k2b-spin" : "ti ti-external-link"} aria-hidden="true" />
            {props.openButtonLabel ?? messages().openPreview}
          </button>
        }
      >
        {(href) => (
          // A plain link to a real address: the browser opens it on the user's own click, and the tab can reload it.
          <a
            ref={(element) => (openButton = element)}
            class="k2b-button"
            data-variant="secondary"
            data-size="sm"
            href={href()}
            target="_blank"
            rel="noopener"
          >
            <i class="ti ti-external-link" aria-hidden="true" />
            {props.openButtonLabel ?? messages().openPreview}
          </a>
        )}
      </Show>
      <Show when={props.onDownload}>
        <button
          type="button"
          class="k2b-button"
          data-variant="secondary"
          data-size="sm"
          onClick={() => props.onDownload?.()}
          disabled={props.disabled?.()}
        >
          <i class="ti ti-download" aria-hidden="true" />
          {messages().download}
        </button>
      </Show>
      <Show when={renderable()}>
        <button
          ref={renderButton}
          type="button"
          class="k2b-button"
          data-variant="secondary"
          data-size="sm"
          onClick={() => void load()}
          disabled={loading() || opening() || props.disabled?.()}
        >
          <i class={loading() ? "ti ti-loader-2 k2b-spin" : "ti ti-file-type-pdf"} aria-hidden="true" />
          {props.buttonLabel ?? messages().previewPdf}
        </button>
      </Show>
      <Show when={tabBlocked()}>
        <span role="alert" class="k2b-content-pdf-preview__notice">
          {messages().pdfPreviewTabBlocked}
        </span>
      </Show>
    </div>
  );
  // Without an inline PDF viewer (`navigator.pdfViewerEnabled === false`, as in Chrome on Android) a frame stays empty
  // or downloads the file, so the viewer explains that instead and leaves the document to the open and download actions.
  const inlineViewer = () => typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
  // Every state uses one placeholder in the viewer's box, so loading changes no layout: idle and loading before a
  // document arrives, and loading over the frame until it has drawn the document.
  const status = () => {
    if (error()) return null;
    if (!url()) return loading() ? "loading" : "idle";
    if (!inlineViewer()) return "no-viewer";
    return drawn() ? null : "loading";
  };
  const viewerBox = () => (
    <div ref={(element) => (viewer = element)} class="k2b-content-pdf-preview__viewer" tabIndex={status() === "no-viewer" ? -1 : undefined}>
      <Show when={!error() && inlineViewer() && url()}>
        {(currentUrl) => (
          <iframe
            ref={(element) => {
              frame = element;
              // A new frame loads its document again, also one that was shown before a failed reload.
              setDrawn(false);
            }}
            class="k2b-content-pdf-preview__frame"
            data-drawn={drawn() ? "" : undefined}
            src={currentUrl()}
            title={props.title ?? messages().pdfPreview}
            onLoad={() => setDrawn(true)}
          />
        )}
      </Show>
      <Show
        when={error()}
        fallback={
          <Show when={status()}>
            {(state) => (
              <Placeholder
                class="k2b-content-pdf-preview__placeholder"
                state={state() === "loading" ? "loading" : "empty"}
                icon={state() === "loading" ? undefined : "ti ti-file-type-pdf"}
                title={state() === "loading" ? messages().loading : state() === "no-viewer" ? messages().pdfPreviewNoViewer : undefined}
                description={
                  state() === "idle"
                    ? (props.emptyText ?? messages().renderPdfPreview)
                    : state() === "no-viewer"
                      ? messages().pdfPreviewNoViewerDescription
                      : undefined
                }
              />
            )}
          </Show>
        }
      >
        {(message) => (
          <Placeholder
            class="k2b-content-pdf-preview__placeholder"
            state="error"
            description={message()}
            action={
              // One retry at a time: the render action moves here only where the toolbar no longer offers it.
              renderable() ? undefined : (
                <button
                  ref={(element) => (errorRetryButton = element)}
                  type="button"
                  class="k2b-button"
                  data-variant="secondary"
                  data-size="sm"
                  onClick={() => void load()}
                  disabled={opening() || props.disabled?.()}
                >
                  {props.buttonLabel ?? messages().retry}
                </button>
              )
            }
          />
        )}
      </Show>
    </div>
  );
  // A caller's error content replaces the whole viewer, as it brings its own layout.
  const content = () => (
    <Show when={props.renderError ? error() : null} fallback={viewerBox()}>
      {(message) => props.renderError?.(message())}
    </Show>
  );

  if (props.children)
    return props.children({
      get actions() {
        return actions();
      },
      get content() {
        return content();
      },
    });
  return (
    <section class={`k2b-content-pdf-preview ${props.class ?? ""}`}>
      <div class="k2b-content-pdf-preview__toolbar">
        <div class="k2b-content-pdf-preview__heading">
          <Show when={props.title}>
            <h2 class="k2b-content-pdf-preview__title">{props.title}</h2>
          </Show>
        </div>
        {actions()}
      </div>
      {content()}
    </section>
  );
}
