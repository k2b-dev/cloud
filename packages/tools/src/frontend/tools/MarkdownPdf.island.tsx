import { AutocompleteEditor, Button, MarkdownEditor, NoticeCard, Select, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type MarkdownPdfMessages, markdownPdfMessages } from "@/api/markdown-pdf-messages";

export type MarkdownPdfTemplateId = "document" | "report" | "compact" | "custom";

type MarkdownPdfViewProps = {
  initialMarkdown?: string;
  initialTemplateId?: MarkdownPdfTemplateId;
  initialCustomCss?: string;
  initialFilename?: string;
  initialError?: string;
  initialBusy?: boolean;
  initialPreviewUrl?: string;
};

const templateOptions = (t: MarkdownPdfMessages) => [
  { id: "document", label: t.templateDocument, description: t.templateDocumentDescription },
  { id: "report", label: t.templateReport, description: t.templateReportDescription },
  { id: "compact", label: t.templateCompact, description: t.templateCompactDescription },
  { id: "custom", label: t.templateCustom, description: t.templateCustomDescription },
];

export const MINIMAL_CUSTOM_CSS = `@page { size: A4; margin: 20mm; }

:root { color: #1f2937; font: 11pt/1.5 system-ui, sans-serif; }

body { margin: 0; }
.markdown-document { overflow-wrap: anywhere; }`;

const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_CUSTOM_CSS_BYTES = 32 * 1024;
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const markdownPdfFilename = (value: string): string => {
  const basename = value.split(/[\\/]/u).at(-1)?.trim() || "document";
  const clean = basename.replace(/[\r\n/:*?"<>|\\]/gu, "-").trim() || "document";
  if (clean.toLowerCase() === ".pdf") return "document.pdf";
  return clean.toLowerCase().endsWith(".pdf") ? clean.slice(0, 255) : `${clean.slice(0, 251)}.pdf`;
};

export const validateMarkdownPdfInput = (
  markdown: string,
  templateId: MarkdownPdfTemplateId,
  customCss: string,
  filename: string,
  t: MarkdownPdfMessages,
): string | null => {
  if (!markdown.trim()) return t.enterMarkdown;
  if (byteLength(markdown) > MAX_MARKDOWN_BYTES) return t.markdownTooLarge;
  if (templateId === "custom" && !customCss.trim()) return t.enterCss;
  if (templateId === "custom" && byteLength(customCss) > MAX_CUSTOM_CSS_BYTES) return t.cssTooLarge;
  if (!filename.trim()) return t.enterFilename;
  if (filename.length > 255) return t.filenameTooLong;
  return null;
};

const responseError = async (response: Response, t: MarkdownPdfMessages): Promise<string> => {
  if (response.status === 401) return t.signInToGenerate;
  if (response.status === 429) return t.tooManyRenders;
  const data: unknown = await response.json().catch(() => null);
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  return t.pdfFailed;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = markdownPdfFilename(filename);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

export function MarkdownPdfView(props: MarkdownPdfViewProps = {}) {
  const locale = useLocale();
  const t = () => markdownPdfMessages.resolve([locale()]).t;
  const [markdown, setMarkdown] = createSignal(props.initialMarkdown ?? "");
  const [templateId, setTemplateId] = createSignal<MarkdownPdfTemplateId>(props.initialTemplateId ?? "document");
  const [customCss, setCustomCss] = createSignal(
    props.initialCustomCss ?? (props.initialTemplateId === "custom" ? MINIMAL_CUSTOM_CSS : ""),
  );
  const [filename, setFilename] = createSignal(props.initialFilename ?? "document.pdf");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(props.initialPreviewUrl ?? null);
  const [pdf, setPdf] = createSignal<Blob | null>(null);
  const [renderedInput, setRenderedInput] = createSignal("");
  const [error, setError] = createSignal(props.initialError ?? "");
  const [busy, setBusy] = createSignal(props.initialBusy ?? false);
  let request: AbortController | null = null;
  let requestRevision = 0;

  const currentInput = () => JSON.stringify([markdown(), templateId(), templateId() === "custom" ? customCss() : ""]);
  const stale = createMemo(() => Boolean(previewUrl() && renderedInput() && renderedInput() !== currentInput()));

  const revokePreview = () => {
    const current = previewUrl();
    if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
    setPreviewUrl(null);
  };

  const cancel = () => {
    requestRevision += 1;
    request?.abort();
    request = null;
    setBusy(false);
  };

  onCleanup(() => {
    cancel();
    revokePreview();
  });

  const generate = async () => {
    cancel();
    const validation = validateMarkdownPdfInput(markdown(), templateId(), customCss(), filename(), t());
    if (validation) {
      setError(validation);
      return;
    }

    const revision = ++requestRevision;
    const controller = new AbortController();
    request = controller;
    setBusy(true);
    setError("");
    const snapshot = currentInput();
    const selectedTemplate = templateId();

    try {
      const response = await apiClient.markdown.pdf.$post(
        {
          json: {
            markdown: markdown(),
            templateId: selectedTemplate === "custom" ? undefined : selectedTemplate,
            customCss: selectedTemplate === "custom" ? customCss() : undefined,
            filename: markdownPdfFilename(filename()),
          },
        },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await responseError(response, t()));
      const blob = await response.blob();
      if (blob.type !== "application/pdf") throw new Error(t().unexpectedFileType);
      if (revision !== requestRevision) return;
      const nextUrl = URL.createObjectURL(blob);
      revokePreview();
      setPdf(blob);
      setPreviewUrl(nextUrl);
      setRenderedInput(snapshot);
    } catch (cause) {
      if (controller.signal.aborted || revision !== requestRevision) return;
      setError(cause instanceof Error ? cause.message : t().pdfFailed);
    } finally {
      if (revision === requestRevision) {
        request = null;
        setBusy(false);
      }
    }
  };

  const download = () => {
    const value = pdf();
    if (value) downloadBlob(value, filename());
  };

  const openPreview = () => {
    const url = previewUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const selectTemplate = (value: string | null) => {
    if (!value) return;
    const next = value as MarkdownPdfTemplateId;
    setTemplateId(next);
    if (next === "custom" && !customCss().trim()) setCustomCss(MINIMAL_CUSTOM_CSS);
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-4" aria-labelledby="markdown-pdf-heading">
      <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(20rem,0.92fr)_minmax(0,1.08fr)]">
        <div class="flex min-h-0 flex-col gap-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <Select
              label={t().templateLabel}
              icon="ti ti-template"
              value={templateId}
              onValueChange={selectTemplate}
              options={templateOptions(t())}
            />
            <TextInput
              label={t().filenameLabel}
              icon="ti ti-file-type-pdf"
              value={filename}
              onValueChange={setFilename}
              maxLength={255}
              spellcheck={false}
            />
          </div>

          <div class="h-[28rem] min-h-0 shrink-0 lg:h-auto lg:flex-1 lg:shrink">
            <MarkdownEditor
              label={t().markdownLabel}
              value={markdown}
              onValueChange={setMarkdown}
              placeholder={t().markdownPlaceholder}
              lines={18}
              fill
              showStats
            />
          </div>

          <Show when={templateId() === "custom"}>
            <div>
              <AutocompleteEditor
                label={t().customCssLabel}
                description={t().customCssDescription}
                value={customCss}
                onValueChange={setCustomCss}
                placeholder={MINIMAL_CUSTOM_CSS}
                lines={8}
                spellcheck={false}
              />
            </div>
          </Show>

          <div class="flex items-start gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 text-xs leading-relaxed text-dimmed">
            <i class="ti ti-server mt-0.5 shrink-0" aria-hidden="true" />
            <p>{t().serverNotice}</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void generate()} loading={busy()} loadingLabel={t().generatingPdf}>
              <i class="ti ti-file-type-pdf" aria-hidden="true" /> {t().generatePdf}
            </Button>
            <Show when={busy()}>
              <Button variant="secondary" onClick={cancel}>
                {t().cancel}
              </Button>
            </Show>
          </div>

          <Show when={error()}>
            <div role="alert">
              <NoticeCard tone="danger" title={t().generationFailedTitle}>
                {error()}
              </NoticeCard>
            </div>
          </Show>
        </div>

        <div class="flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ui-border)] px-4 py-3">
            <div class="min-w-0">
              <h2 id="markdown-pdf-heading" class="font-medium text-primary">
                {t().previewTitle}
              </h2>
              <p class="text-xs text-dimmed">{t().previewDescription}</p>
            </div>
            <Show when={previewUrl()}>
              <div class="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={openPreview}>
                  <i class="ti ti-external-link" aria-hidden="true" /> {t().open}
                </Button>
                <Button variant="primary" size="sm" onClick={download} disabled={!pdf()}>
                  <i class="ti ti-download" aria-hidden="true" /> {t().downloadPdf}
                </Button>
              </div>
            </Show>
          </div>

          <Show when={stale()}>
            <div class="border-b border-[var(--ui-border)] px-4 py-3">
              <NoticeCard tone="warning" title={t().staleTitle}>
                {t().staleBody}
              </NoticeCard>
            </div>
          </Show>

          <Show
            when={previewUrl()}
            fallback={
              <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-dimmed">
                <i class="ti ti-file-type-pdf text-4xl" aria-hidden="true" />
                <p class="font-medium text-primary">{t().emptyTitle}</p>
                <p class="max-w-sm text-sm">{t().emptyDescription}</p>
              </div>
            }
          >
            {(url) => (
              <>
                <p class="k2b-sr-only" role="status">
                  {t().generationComplete}
                </p>
                <iframe class="min-h-[28rem] flex-1 bg-white" src={url()} title={t().iframeTitle} />
              </>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

export default function MarkdownPdf() {
  return <MarkdownPdfView />;
}
