import { AutocompleteEditor, MarkdownEditor, useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Empty, Field, Input, Notice, Pane, Section, Select, StatusRow, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type MarkdownPdfMessages, markdownPdfMessages } from "@/api/markdown-pdf-messages";
import ToolsScreen from "../ToolsScreen";

const TEMPLATE_IDS = ["document", "report", "compact", "custom"] as const;
export type MarkdownPdfTemplateId = (typeof TEMPLATE_IDS)[number];

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

const responseError = async (response: Pick<Response, "json" | "status">, t: MarkdownPdfMessages): Promise<string> => {
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
    const next = TEMPLATE_IDS.find((id) => id === value);
    if (!next) return;
    setTemplateId(next);
    if (next === "custom" && !customCss().trim()) setCustomCss(MINIMAL_CUSTOM_CSS);
  };

  const lead = () =>
    busy()
      ? t().generatingPdf
      : error()
        ? t().generationFailedTitle
        : stale()
          ? t().staleTitle
          : previewUrl()
            ? t().generationComplete
            : t().emptyTitle;
  const template = () => templateOptions(t()).find((option) => option.id === templateId());

  return (
    <ToolsScreen
      tool="markdown-pdf"
      primary={{ label: t().generatePdf, icon: "file-type-pdf", onClick: () => void generate() }}
      end={
        <Button variant="primary" icon="file-type-pdf" busy={busy()} onClick={() => void generate()}>
          {t().generatePdf}
        </Button>
      }
    >
      <Pane.Split>
        <Pane label={t().markdownLabel} scrollKey="tools-markdown-pdf">
          <Show when={error()}>
            {(message) => (
              <Notice tone="bad" title={t().generationFailedTitle}>
                {message()}
              </Notice>
            )}
          </Show>
          <Band>
            <Field.Row>
              <Field label={t().templateLabel} hint={template()?.description}>
                <Select
                  options={templateOptions(t()).map((option) => ({ value: option.id, label: option.label }))}
                  value={templateId()}
                  onChange={selectTemplate}
                />
              </Field>
              <Field label={t().filenameLabel}>
                <Input value={filename()} onInput={setFilename} maxLength={255} spellcheck={false} />
              </Field>
            </Field.Row>
            <Text type="meta" muted>
              {t().serverNotice}
            </Text>
          </Band>
          {/* The Markdown editor keeps its own behaviour (toolbar, shortcuts, counts); v2 has none of its own yet. */}
          <Canvas label={t().markdownLabel} height={520}>
            <MarkdownEditor
              label={t().markdownLabel}
              value={markdown}
              onValueChange={setMarkdown}
              placeholder={t().markdownPlaceholder}
              lines={18}
              variant="embedded"
              fill
              showStats
            />
          </Canvas>
          <Show when={templateId() === "custom"}>
            <Section icon="brand-css3" title={t().customCssLabel} summary={t().customCssDescription}>
              <Canvas label={t().customCssLabel} height={220}>
                <AutocompleteEditor
                  label={t().customCssLabel}
                  value={customCss}
                  onValueChange={setCustomCss}
                  placeholder={MINIMAL_CUSTOM_CSS}
                  lines={8}
                  variant="embedded"
                  spellcheck={false}
                />
              </Canvas>
            </Section>
          </Show>
        </Pane>
        <Pane
          label={t().previewTitle}
          status={
            <StatusRow
              lead={lead()}
              loading={busy()}
              facts={[{ after: t().previewDescription }]}
              filters={
                <Show
                  when={busy()}
                  fallback={
                    <Show when={previewUrl()}>
                      <Button variant="ghost" icon="external-link" onClick={openPreview}>
                        {t().open}
                      </Button>
                      <Button variant="ghost" icon="download" disabled={!pdf()} onClick={download}>
                        {t().downloadPdf}
                      </Button>
                    </Show>
                  }
                >
                  <Button variant="ghost" icon="x" onClick={cancel}>
                    {t().cancel}
                  </Button>
                </Show>
              }
            />
          }
        >
          <Show when={stale()}>
            <Notice tone="warn" title={t().staleTitle} actions={[{ label: t().generatePdf, onClick: () => void generate() }]}>
              {t().staleBody}
            </Notice>
          </Show>
          <Show when={previewUrl()} fallback={<Empty icon="file-type-pdf" text={t().emptyDescription} />}>
            {(url) => (
              // k2b-ui gap: no document viewer in v2; the browser's own PDF view stands in a Canvas.
              <Canvas label={t().iframeTitle} height={760}>
                <iframe src={url()} title={t().iframeTitle} style={{ border: 0, width: "100%", height: "100%", background: "#fff" }} />
              </Canvas>
            )}
          </Show>
        </Pane>
      </Pane.Split>
    </ToolsScreen>
  );
}

export default function MarkdownPdf() {
  return <MarkdownPdfView />;
}
