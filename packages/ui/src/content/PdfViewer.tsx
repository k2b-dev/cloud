import { batch, createEffect, createSignal, type JSX, lazy, on, onCleanup, Show } from "solid-js";
import { announce } from "../feedback/announce";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";
import type { PdfPagesAction } from "./PdfPages";
import { resolvePdfMessages, usePdfMessages } from "./pdf-messages";

/** Loads a PDF when the viewer needs it. A failed `Response` becomes the error state with its `message`. */
export type PdfViewerRequest = () => Promise<Response | Blob>;

export type PdfViewerProps = {
  /** The document's name, for the page area, the page images, and a tab opened from the pill. */
  title: string;
  /**
   * The PDF to show: its bytes, or the address of one on this site, which the viewer fetches. A new value shows that
   * document; the shown pages stay until its first pages are drawn. Pass either `data` or `request`.
   */
  data?: Blob | ArrayBuffer | string;
  /**
   * Requests the PDF: at once with `autoLoad`, otherwise from the action in the empty state. A new request replaces a
   * running one, and the shown pages stay while it loads.
   */
  request?: PdfViewerRequest;
  /** Runs `request` as soon as the viewer shows. Without it, the person starts it. */
  autoLoad?: boolean;
  /** Keeps a requested document from loading, such as while its input is incomplete. */
  disabled?: boolean;
  /** The empty state's text before an on-demand request. */
  emptyText?: string;
  /** Names the action that runs an on-demand `request`; once a document shows, it renders again from the pill. */
  loadLabel?: string;
  /**
   * Adds "Open in new tab" to the pill and the error state: `true` opens the shown document, an address opens that
   * address, which reloads and keeps the document's name.
   */
  open?: boolean | string;
  /** Without the zoom controls, always fitted. Defaults to `true`. */
  zoom?: boolean;
  /**
   * With `zoom` false, a factor of the fitted width, such as 1.5, for a host that zooms with its own controls, like
   * `Lightbox`. Defaults to 1.
   */
  scale?: number;
  /**
   * How a fitted document fills the area: `"width"` (the default) fits each page to the area's width, for reading;
   * `"page"` shows the whole first page in the area's height, narrower, for a preview beside other content.
   * Fitted pages never grow past 100 %.
   */
  fit?: "width" | "page";
  /** Shows only this page (zero-based) instead of all pages one below the other. */
  page?: number;
  /**
   * The first visible page is drawn, again for each new document; `pages` counts the document's pages, such as for a
   * host's "4 pages".
   */
  onReady?: (document: { pages: number }) => void;
  /** The request failed, or pdf.js could not open or draw the document; the viewer shows its error state. */
  onError?: (error: unknown) => void;
  /** The page in the middle of the view changed (zero-based), for a host that shows "Page 2 / 4" itself. */
  onPage?: (index: number) => void;
  class?: string;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as unknown;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  } catch {
    // Fall through to the HTTP status fallback.
  }
  return resolvePdfMessages().pdfPreviewHttpError({ status: response.status });
};

const toBlob = async (response: Response | Blob): Promise<Blob> => {
  const blob = response instanceof Response ? (response.ok ? await response.blob() : null) : response;
  if (!blob) throw new Error(await readErrorMessage(response as Response));
  if (blob.type && blob.type !== "application/pdf") throw new Error(`PDF preview returned ${blob.type} instead of application/pdf`);
  return blob;
};

/** A load that ends within this time shows no progress line; a person reads a shorter wait as instant. */
const QUIET_DELAY_MS = 400;

// The pages and pdf.js load only once a document shows, so a page that never shows one carries neither.
const PdfPages = lazy(() => import("./PdfPages"));

/**
 * Shows a PDF with pdf.js on a grey, rounded ground: pages as images with selectable text and a small pill for the
 * page, zoom, and fit. Pass the document as `data`, or a `request` that loads it; the viewer shows the empty, loading,
 * and error states in the same area, so nothing around it moves. A new document loads behind the shown pages, which
 * keep their zoom and, for the same pages under the same title, their scroll position; a thin line on the top edge
 * shows a longer wait, and a failed load replaces the pages with its error.
 */
export default function PdfViewer(props: PdfViewerProps): JSX.Element {
  const messages = useUiMessages();
  const pdfMessages = usePdfMessages();
  // The document pdf.js draws.
  const [shown, setShown] = createSignal<Blob | ArrayBuffer | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // pdf.js could not draw the shown document; the error state offers it in a new tab.
  const [undrawable, setUndrawable] = createSignal(false);
  const [drawn, setDrawn] = createSignal(false);
  // A new document is opening while the previous one stays drawn.
  const [replacing, setReplacing] = createSignal(false);
  const [tabBlocked, setTabBlocked] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let generation = 0;
  let disposed = false;
  // Fetching an address stops when the viewer goes or loads another one.
  let fetching: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    generation += 1;
    fetching?.abort();
  });

  /** A drawn document stays until the new one's first pages are drawn; otherwise the loading state shows. */
  const show = (document: Blob | ArrayBuffer) => {
    const keep = drawn() && Boolean(shown()) && !undrawable();
    setUndrawable(false);
    setDrawn(keep);
    setReplacing(keep);
    setError(null);
    setShown(document);
  };

  /**
   * Loads from the address or the request. A person's click waits for a running load; a changed source (`replace`)
   * supersedes it. A newer load or the end of the viewer drops a late answer.
   */
  const load = async (replace = false) => {
    const source = props.data;
    const request =
      typeof source === "string"
        ? () => {
            fetching?.abort();
            fetching = new AbortController();
            return fetch(source, { credentials: "same-origin", signal: fetching.signal });
          }
        : source
          ? undefined
          : props.request;
    if (!request || (loading() && !replace) || props.disabled) return;
    const current = ++generation;
    // The focused render or retry action leaves with the state it belongs to: keyboard focus moves to the viewer at
    // once instead of dropping to the page.
    const focused = root?.contains(document.activeElement) ?? false;
    setLoading(true);
    setError(null);
    setUndrawable(false);
    if (focused && root && !root.contains(document.activeElement)) root.focus();
    try {
      const blob = await toBlob(await request());
      if (disposed || current !== generation) return;
      show(blob);
    } catch (cause) {
      if (disposed || current !== generation) return;
      setError(cause instanceof Error ? cause.message : pdfMessages().pdfPreview);
      // A host that shows its own states, such as the Lightbox, learns of a failed request as of an undrawable file.
      props.onError?.(cause);
    } finally {
      if (!disposed && current === generation) setLoading(false);
      if (focused && document.activeElement === document.body) root?.focus();
    }
  };

  // Bytes show at once and an address loads, again whenever `data` changes; either replaces a running load.
  createEffect(
    on(
      () => props.data,
      (data) => {
        if (data instanceof Blob || data instanceof ArrayBuffer) {
          fetching?.abort();
          generation += 1;
          setLoading(false);
          show(data);
        } else if (typeof data === "string") void load(true);
      },
    ),
  );
  // An automatic request runs once it may, and again for a new request, which replaces a running one.
  let requested: PdfViewerRequest | undefined;
  createEffect(
    on(
      () => [props.data, props.request, props.autoLoad, props.disabled] as const,
      ([data, request, autoLoad, disabled]) => {
        if (data !== undefined || !request || !autoLoad || disabled) return;
        if (request === requested && (shown() || loading())) return;
        requested = request;
        void load(true);
      },
    ),
  );

  const openInTab = async () => {
    setTabBlocked(false);
    const address = typeof props.open === "string" ? props.open : null;
    if (address) {
      // Without "noopener" in the call, so the browser reports a blocked tab; `opener = null` cuts the link instead.
      const tab = window.open(address, "_blank");
      setTabBlocked(!tab);
      if (tab) tab.opener = null;
      return;
    }
    const pdf = shown();
    if (!pdf) return;
    const tab = window.open("", "_blank");
    setTabBlocked(!tab);
    if (!tab) return;
    tab.opener = null;
    tab.document.title = props.title;
    tab.document.body.textContent = pdfMessages().pdfPreviewRendering;
    const url = URL.createObjectURL(pdf instanceof Blob ? pdf : new Blob([pdf], { type: "application/pdf" }));
    tab.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const onDemand = () => Boolean(props.request) && !props.autoLoad && props.data === undefined;
  const actions = (): PdfPagesAction[] => [
    ...(props.open ? [{ label: pdfMessages().pdfOpenInTab, icon: "ti ti-external-link", onClick: () => void openInTab() }] : []),
    ...(onDemand()
      ? [
          {
            label: props.loadLabel ?? pdfMessages().previewPdf,
            icon: loading() ? "ti ti-loader-2 k2b-spin" : "ti ti-refresh",
            disabled: loading() || props.disabled,
            onClick: () => void load(),
          },
        ]
      : []),
  ];

  const undrawableNow = (cause: unknown) => {
    setUndrawable(true);
    setDrawn(false);
    setReplacing(false);
    announce(pdfMessages().pdfPreviewNoViewer);
    props.onError?.(cause);
  };

  // One placeholder for every state but the drawn document, in the same area.
  const status = (): "idle" | "loading" | "error" | "undrawable" | null => {
    if (error()) return "error";
    if (undrawable()) return "undrawable";
    if (!shown()) return loading() || (!onDemand() && !props.disabled && (props.data !== undefined || props.request)) ? "loading" : "idle";
    return drawn() ? null : "loading";
  };
  // While the shown pages wait for a new document, a quiet line appears after a short wait, so a fast load never flickers.
  const busy = () => !status() && (loading() || replacing());
  const [quiet, setQuiet] = createSignal(false);
  createEffect(
    on(busy, (waiting) => {
      setQuiet(false);
      if (!waiting) return;
      const timer = setTimeout(() => setQuiet(true), QUIET_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  // A document pdf.js cannot draw can still open in the browser's viewer, and a generated one can render again, for
  // example after its template input was corrected.
  const undrawableActions = () =>
    props.open || onDemand() ? (
      <>
        <Show when={onDemand()}>{action(props.loadLabel ?? pdfMessages().previewPdf, () => void load(), loading() || props.disabled)}</Show>
        <Show when={props.open}>{action(pdfMessages().pdfOpenInTab, () => void openInTab())}</Show>
      </>
    ) : undefined;
  const action = (label: string, run: () => void, disabled?: boolean) => (
    <button type="button" class="k2b-button" data-variant="secondary" data-size="sm" disabled={disabled} onClick={run}>
      {label}
    </button>
  );

  return (
    <div
      ref={root}
      class={`k2b-pdf-viewer ${props.class ?? ""}`}
      data-state={status() ?? "shown"}
      // While a placeholder shows, the viewer holds keyboard focus that has nowhere else to go.
      tabIndex={status() ? -1 : undefined}
      aria-busy={busy() ? "true" : undefined}
    >
      <Show when={!undrawable() && shown()}>
        {(pdf) => (
          <PdfPages
            data={pdf()}
            title={props.title}
            zoom={props.zoom}
            scale={props.scale}
            fit={props.fit}
            page={props.page}
            actions={actions()}
            onReady={(drawnDocument) => {
              const waiting = document.activeElement === root;
              batch(() => {
                setDrawn(true);
                setReplacing(false);
              });
              if (waiting) root?.querySelector<HTMLElement>(".k2b-pdf-viewer__pages")?.focus();
              props.onReady?.(drawnDocument);
            }}
            onError={undrawableNow}
            onPage={props.onPage}
          />
        )}
      </Show>
      <Show when={status()}>
        {(state) => (
          <Placeholder
            class="k2b-pdf-viewer__placeholder"
            state={state() === "loading" ? "loading" : state() === "error" ? "error" : "empty"}
            icon={state() === "idle" || state() === "undrawable" ? "ti ti-file-type-pdf" : undefined}
            title={state() === "loading" ? messages().loading : state() === "undrawable" ? pdfMessages().pdfPreviewNoViewer : undefined}
            description={
              state() === "idle"
                ? (props.emptyText ?? pdfMessages().renderPdfPreview)
                : state() === "error"
                  ? (error() ?? undefined)
                  : state() === "undrawable"
                    ? pdfMessages().pdfPreviewNoViewerDescription
                    : undefined
            }
            action={
              state() === "idle" && onDemand()
                ? action(props.loadLabel ?? pdfMessages().previewPdf, () => void load(), props.disabled)
                : state() === "error" && (props.request || typeof props.data === "string")
                  ? action(messages().retry, () => void load(), loading() || props.disabled)
                  : state() === "undrawable"
                    ? undrawableActions()
                    : undefined
            }
          />
        )}
      </Show>
      <Show when={quiet()}>
        <span class="k2b-pdf-viewer__progress" aria-hidden="true" />
      </Show>
      <Show when={tabBlocked()}>
        <p role="alert" class="k2b-pdf-viewer__notice">
          {pdfMessages().pdfPreviewTabBlocked}
        </p>
      </Show>
    </div>
  );
}
