import { createSignal, onCleanup, Show } from "solid-js";
import { resolveUiMessages, useUiMessages } from "../intl/messages";

export type PdfPreviewRequest = () => Promise<Response | Blob>;

export type PdfPreviewProps = {
  request: PdfPreviewRequest;
  disabled?: () => boolean;
  title?: string;
  buttonLabel?: string;
  openButtonLabel?: string;
  emptyText?: string;
  class?: string;
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
  const [loading, setLoading] = createSignal(false);
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
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
      setUrl(nextUrl);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch (e) {
      if (!disposed && generation === loadGeneration) setError(e instanceof Error ? e.message : "PDF preview failed");
    } finally {
      if (!disposed && generation === loadGeneration) setLoading(false);
    }
  };

  const openInNewTab = async () => {
    if (loading() || opening() || props.disabled?.()) return;
    const generation = ++openGeneration;
    const tab = window.open("", "_blank");
    if (!tab) {
      setError("Browser blocked the preview tab");
      return;
    }
    tab.opener = null;
    tab.document.title = props.title ?? messages().pdfPreview;
    tab.document.body.textContent = "Rendering PDF preview...";
    setOpening(true);
    setError(null);
    try {
      const blob = await readPdfBlob();
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

  return (
    <section class={`k2b-content-pdf-preview ${props.class ?? ""}`}>
      <div class="k2b-content-pdf-preview__toolbar">
        <div class="k2b-content-pdf-preview__heading">
          <Show when={props.title}>
            <h2 class="k2b-content-pdf-preview__title">{props.title}</h2>
          </Show>
        </div>
        <div class="k2b-content-pdf-preview__actions">
          <button
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
          <button
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
        </div>
      </div>

      <Show
        when={url()}
        fallback={
          <div class="k2b-content-pdf-preview__empty">
            <Show when={error()} fallback={<span>{props.emptyText ?? messages().renderPdfPreview}</span>}>
              {(message) => <div class="k2b-content-pdf-preview__error">{message()}</div>}
            </Show>
          </div>
        }
      >
        {(currentUrl) => <iframe class="k2b-content-pdf-preview__frame" src={currentUrl()} title={props.title ?? messages().pdfPreview} />}
      </Show>
    </section>
  );
}
