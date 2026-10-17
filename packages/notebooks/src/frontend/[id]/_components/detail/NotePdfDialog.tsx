import {
  AutocompleteEditor,
  Button,
  dialogCore,
  InlineGuidance,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  Select,
  useLocale,
} from "@k2b/ui";
import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notePdfOmissionText } from "@/lib/book-renderer-messages";
import { decodeNotePdfOmissions, NOTE_PDF_OMISSIONS_HEADER, type NotePdfOmissionReport } from "@/lib/pdf-omissions";
import { notebookWorkspaceMessages } from "../../messages";

type NotePdfTemplateId = "document" | "report" | "compact" | "custom";

type NotePdfDialogProps = {
  notebookId: string;
  noteId: string;
  noteTitle: string;
  markdown: string;
};

const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_CUSTOM_CSS_BYTES = 32 * 1024;
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const MINIMAL_NOTE_PDF_CSS = `@page { size: A4; margin: 20mm; }

:root { color: #1f2937; font: 11pt/1.5 system-ui, sans-serif; }

body { margin: 0; }
.markdown-document { overflow-wrap: anywhere; }`;

const pdfFilename = (title: string): string => {
  const clean =
    title
      .replace(/[\r\n/:*?"<>|\\]/gu, "-")
      .replace(/\s+/gu, " ")
      .trim() || "note";
  return `${clean.slice(0, 251)}.pdf`;
};

const responseError = async (response: Pick<Response, "json" | "status">, rateLimited: string, fallback: string): Promise<string> => {
  if (response.status === 429) return rateLimited;
  const data: unknown = await response.json().catch(() => null);
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  return fallback;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

function NotePdfDialog(props: NotePdfDialogProps & { close: () => void }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const templateOptions = () => [
    { id: "document", label: t().pdfDocument, description: t().pdfDocumentDescription },
    { id: "report", label: t().pdfReport, description: t().pdfReportDescription },
    { id: "compact", label: t().pdfCompact, description: t().pdfCompactDescription },
    { id: "custom", label: t().pdfCustom, description: t().pdfCustomDescription },
  ];
  const [templateId, setTemplateId] = createSignal<NotePdfTemplateId>("document");
  const [customCss, setCustomCss] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  // What the last downloaded PDF left out. It stays until the next answer replaces it, so nothing blinks while loading.
  const [report, setReport] = createSignal<NotePdfOmissionReport | null>(null);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const detailsId = createUniqueId();
  const omissionSummary = () => t().pdfOmissionsTitle({ count: (report()?.items.length ?? 0) + (report()?.more ?? 0) });
  let request: AbortController | null = null;

  const close = () => {
    request?.abort();
    props.close();
  };
  onCleanup(() => request?.abort());

  const selectTemplate = (value: string | null) => {
    if (!value) return;
    const next = value as NotePdfTemplateId;
    setTemplateId(next);
    if (next === "custom" && !customCss().trim()) setCustomCss(MINIMAL_NOTE_PDF_CSS);
  };

  const generate = async () => {
    if (!props.markdown.trim()) {
      setError(t().pdfNoContent);
      return;
    }
    if (byteLength(props.markdown) > MAX_MARKDOWN_BYTES) {
      setError(t().pdfTooLarge);
      return;
    }
    if (templateId() === "custom" && !customCss().trim()) {
      setError(t().pdfCssRequired);
      return;
    }
    if (templateId() === "custom" && byteLength(customCss()) > MAX_CUSTOM_CSS_BYTES) {
      setError(t().pdfCssTooLarge);
      return;
    }

    request?.abort();
    const controller = new AbortController();
    request = controller;
    setBusy(true);
    setError("");
    const selectedTemplate = templateId();
    try {
      const response = await apiClient[":id"].notes[":noteId"].pdf.$post(
        {
          param: { id: props.notebookId, noteId: props.noteId },
          json: {
            markdown: props.markdown,
            templateId: selectedTemplate === "custom" ? undefined : selectedTemplate,
            customCss: selectedTemplate === "custom" ? customCss() : undefined,
          },
        },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await responseError(response, t().pdfRateLimited, t().pdfFailed));
      const blob = await response.blob();
      if (blob.type !== "application/pdf") throw new Error(t().pdfUnexpectedType);
      if (controller.signal.aborted) return;
      downloadBlob(blob, pdfFilename(props.noteTitle));
      // A complete PDF closes the dialog as before; otherwise the dialog stays and says what the PDF left out.
      const omissions = decodeNotePdfOmissions(response.headers.get(NOTE_PDF_OMISSIONS_HEADER));
      if (!omissions || omissions.items.length + omissions.more === 0) {
        props.close();
        return;
      }
      setReport(omissions);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setReport(null);
        setError(cause instanceof Error ? cause.message : t().pdfFailed);
      }
    } finally {
      if (request === controller) {
        request = null;
        setBusy(false);
      }
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().downloadPdf}
        subtitle={t().pdfSubtitle({ title: props.noteTitle || t().thisNote })}
        icon="ti ti-file-type-pdf"
        close={close}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={t().printStyle} subtitle={t().printStyleDescription} icon="ti ti-template">
          <div class="flex flex-col gap-4">
            <Select
              label={t().template}
              icon="ti ti-template"
              value={templateId}
              onValueChange={selectTemplate}
              options={templateOptions()}
            />
            <Show when={templateId() === "custom"}>
              <AutocompleteEditor
                label={t().customCss}
                description={t().customCssDescription}
                value={customCss}
                onValueChange={setCustomCss}
                placeholder={MINIMAL_NOTE_PDF_CSS}
                lines={9}
                spellcheck={false}
              />
            </Show>
            {/* One reserved place: the data notice and the summary of what the PDF left out share one cell that
                always holds both, so the summary arrives without moving anything. The live region exists from the
                start, so screen readers announce the summary. */}
            <div class="grid">
              <InlineGuidance
                icon="ti ti-server"
                class="[grid-area:1/1]"
                classList={{ invisible: Boolean(report()) }}
                aria-hidden={report() ? "true" : undefined}
              >
                {t().pdfDataNotice}
              </InlineGuidance>
              <InlineGuidance
                tone="warning"
                icon="ti ti-alert-triangle"
                class="[grid-area:1/1]"
                classList={{ invisible: !report() }}
                aria-hidden={report() ? undefined : "true"}
                data-pdf-omissions={report() ? "" : undefined}
              >
                {omissionSummary()}{" "}
                <Button
                  type="button"
                  variant="text"
                  size="xs"
                  aria-expanded={detailsOpen()}
                  aria-controls={detailsId}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  {t().pdfOmissionsDetails}
                  <i
                    class="ti ti-chevron-down transition-transform motion-reduce:transition-none"
                    classList={{ "rotate-180": detailsOpen() }}
                    aria-hidden="true"
                  />
                </Button>
              </InlineGuidance>
              <span class="sr-only" role="status" aria-live="polite">
                {report() ? omissionSummary() : ""}
              </span>
            </div>
            <Show when={report() && detailsOpen() ? report() : null}>
              {(current) => (
                <ul id={detailsId} class="flex min-w-0 flex-col gap-2.5 text-sm" data-pdf-omission-list="">
                  <For each={current().items}>
                    {(item) => {
                      const text = () => notePdfOmissionText(item, locale());
                      return (
                        <li class="flex min-w-0 flex-col gap-0.5">
                          <span class="min-w-0 break-words">
                            <span class="font-medium">{text().kind}</span>
                            <Show when={item.label}>
                              {(label) => (
                                <>
                                  <span class="text-dimmed" aria-hidden="true">
                                    {" · "}
                                  </span>
                                  <span class="sr-only">: </span>
                                  {label()}
                                </>
                              )}
                            </Show>
                          </span>
                          <span class="text-dimmed">
                            {text().reason} {text().hint}
                          </span>
                        </li>
                      );
                    }}
                  </For>
                  <li class="text-dimmed">
                    {current().more > 0 ? t().pdfOmissionsMore({ count: current().more }) : t().pdfOmissionsMarked}
                  </li>
                </ul>
              )}
            </Show>
            <Show when={error()}>
              <div role="alert">
                <NoticeCard tone="danger" title={t().pdfGenerationFailed}>
                  {error()}
                </NoticeCard>
              </div>
            </Show>
          </div>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button type="button" variant="secondary" size="sm" onClick={close}>
          {/* Both labels share one cell, so the button keeps its width when Cancel becomes Close. */}
          <span class="grid">
            <span class="[grid-area:1/1]">{report() && !busy() ? t().close : t().cancel}</span>
            <span class="invisible [grid-area:1/1]" aria-hidden="true">
              {report() && !busy() ? t().cancel : t().close}
            </span>
          </span>
        </Button>
        <Button type="button" size="sm" onClick={() => void generate()} loading={busy()} loadingLabel={t().generatingPdf}>
          <i class="ti ti-download" aria-hidden="true" /> {t().downloadPdf}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openNotePdfDialog = (props: NotePdfDialogProps): Promise<void> =>
  dialogCore.open<void>((close) => <NotePdfDialog {...props} close={() => close()} />, panelDialogOptions);
