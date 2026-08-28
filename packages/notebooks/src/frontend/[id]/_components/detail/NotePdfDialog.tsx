import { AutocompleteEditor, Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, Select, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
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

const responseError = async (response: Response, rateLimited: string, fallback: string): Promise<string> => {
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
      downloadBlob(blob, pdfFilename(props.noteTitle));
      props.close();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t().pdfFailed);
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
            <Select label={t().template} icon="ti ti-template" value={templateId} onValueChange={selectTemplate} options={templateOptions()} />
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
            <p class="flex items-start gap-2 text-xs leading-relaxed text-dimmed">
              <i class="ti ti-server mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t().pdfDataNotice}</span>
            </p>
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
          {t().cancel}
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
