import { Button, CopyButton, FileDropzone, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type DocumentMarkdownMessages, documentMarkdownMessages } from "@/api/document-markdown-messages";

export type DocumentMarkdownResult = {
  filename: string;
  format: string;
  markdown: string;
  inputBytes: number;
  outputBytes: number;
  truncated: boolean;
};

type DocumentMarkdownViewProps = {
  initialResult?: DocumentMarkdownResult | null;
  initialError?: string | null;
  initialBusy?: boolean;
  initialFilename?: string;
};

const ACCEPTED_DOCUMENTS = ".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,.xlsx,.ods,.csv,.epub";
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_FILENAME_CHARACTERS = 255;

export const validateDocumentMarkdownFile = (file: Pick<File, "name" | "size">, t: DocumentMarkdownMessages): string | null => {
  if (file.name.length > MAX_FILENAME_CHARACTERS) return t.filenameTooLong;
  if (file.size > MAX_DOCUMENT_BYTES) return t.documentTooLarge;
  return null;
};

export const markdownDownloadName = (filename: string): string => {
  const clean = filename.split(/[\\/]/u).at(-1)?.trim() || "document";
  const stem = clean.replace(/\.[^.]+$/u, "").trim() || "document";
  return `${stem}.md`;
};

const errorMessage = async (response: Response, t: DocumentMarkdownMessages): Promise<string> => {
  if (response.status === 401) return t.signInToConvert;
  if (response.status === 429) return t.tooManyConversions;
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  return t.conversionFailed;
};

const isResult = (value: unknown): value is DocumentMarkdownResult =>
  Boolean(
    value &&
      typeof value === "object" &&
      "filename" in value &&
      typeof value.filename === "string" &&
      "markdown" in value &&
      typeof value.markdown === "string" &&
      "format" in value &&
      typeof value.format === "string" &&
      "inputBytes" in value &&
      typeof value.inputBytes === "number" &&
      "outputBytes" in value &&
      typeof value.outputBytes === "number" &&
      "truncated" in value &&
      typeof value.truncated === "boolean",
  );

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const downloadMarkdown = (result: DocumentMarkdownResult): void => {
  const url = URL.createObjectURL(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = markdownDownloadName(result.filename);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

export function DocumentMarkdownView(props: DocumentMarkdownViewProps = {}) {
  const locale = useLocale();
  const t = () => documentMarkdownMessages.resolve([locale()]).t;
  const [selectedFilename, setSelectedFilename] = createSignal(props.initialResult?.filename ?? props.initialFilename ?? "");
  const [result, setResult] = createSignal<DocumentMarkdownResult | null>(props.initialResult ?? null);
  const [error, setError] = createSignal(props.initialError ?? "");
  const [busy, setBusy] = createSignal(props.initialBusy ?? false);
  let activeRequest: AbortController | null = null;
  let requestRevision = 0;

  const cancel = () => {
    requestRevision += 1;
    activeRequest?.abort();
    activeRequest = null;
    setBusy(false);
  };
  onCleanup(() => {
    requestRevision += 1;
    activeRequest?.abort();
    activeRequest = null;
  });

  const convert = async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    cancel();
    setSelectedFilename(file.name);
    setResult(null);
    const validationError = validateDocumentMarkdownFile(file, t());
    if (validationError) {
      setError(validationError);
      return;
    }
    const revision = ++requestRevision;
    const controller = new AbortController();
    activeRequest = controller;
    setError("");
    setBusy(true);

    try {
      const response = await apiClient.documents.markdown.$post({ form: { file } }, { init: { signal: controller.signal } });
      if (!response.ok) throw new Error(await errorMessage(response, t()));
      const value: unknown = await response.json();
      if (!isResult(value)) throw new Error(t().unexpectedResult);
      if (revision === requestRevision) setResult(value);
    } catch (cause) {
      if (controller.signal.aborted || revision !== requestRevision) return;
      setError(cause instanceof Error ? cause.message : t().conversionFailed);
    } finally {
      if (revision === requestRevision) {
        activeRequest = null;
        setBusy(false);
      }
    }
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-4" aria-labelledby="document-markdown-heading">
      <div class="grid min-h-0 gap-4 lg:grid-cols-[minmax(17rem,0.72fr)_minmax(0,1.28fr)]">
        <div class="flex flex-col gap-3">
          <FileDropzone
            accept={ACCEPTED_DOCUMENTS}
            multiple={false}
            disabled={busy()}
            icon={busy() ? "ti ti-loader-2 k2b-spin" : "ti ti-markdown"}
            title={busy() ? t().convertingDocument : t().dropTitle}
            subtitle={t().dropSubtitle}
            hint={t().dropHint}
            aria-label={t().dropAriaLabel}
            onDrop={convert}
          />

          <div class="flex items-start gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 text-xs leading-relaxed text-dimmed">
            <i class="ti ti-server mt-0.5 shrink-0" aria-hidden="true" />
            <p>{t().serverNotice}</p>
          </div>

          <Show when={busy()}>
            <div class="flex items-center justify-between gap-3" role="status" aria-live="polite">
              <span class="min-w-0 truncate text-sm text-dimmed">{t().convertingFile({ filename: selectedFilename() })}</span>
              <Button variant="secondary" size="sm" onClick={cancel}>
                {t().cancel}
              </Button>
            </div>
          </Show>

          <Show when={error()}>
            <div role="alert">
              <NoticeCard tone="danger" title={t().conversionFailedTitle}>
                {error()}
              </NoticeCard>
            </div>
          </Show>
        </div>

        <div class="flex min-h-[20rem] min-w-0 flex-col rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
          <Show
            when={result()}
            fallback={
              <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-dimmed">
                <i class="ti ti-markdown text-3xl" aria-hidden="true" />
                <h2 id="document-markdown-heading" class="font-medium text-primary">
                  {t().previewTitle}
                </h2>
                <p class="max-w-sm text-sm">{t().previewDescription}</p>
              </div>
            }
          >
            {(resolved) => (
              <>
                <p class="k2b-sr-only" role="status">
                  {t().conversionComplete({ filename: resolved().filename })}
                </p>
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ui-border)] px-4 py-3">
                  <div class="min-w-0">
                    <h2 id="document-markdown-heading" class="truncate font-medium text-primary">
                      {resolved().filename}
                    </h2>
                    <p class="text-xs text-dimmed">
                      {t().resultMeta({
                        format: resolved().format.toUpperCase(),
                        input: formatBytes(resolved().inputBytes),
                        output: formatBytes(resolved().outputBytes),
                      })}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <CopyButton text={resolved().markdown} label={t().copyMarkdown} variant="secondary" size="sm" />
                    <Button variant="primary" size="sm" onClick={() => downloadMarkdown(resolved())}>
                      <i class="ti ti-download" aria-hidden="true" /> {t().downloadMd}
                    </Button>
                  </div>
                </div>
                <Show when={resolved().truncated}>
                  <div class="px-4 pt-3">
                    <NoticeCard tone="warning" title={t().truncatedTitle}>
                      {t().truncatedBody}
                    </NoticeCard>
                  </div>
                </Show>
                <textarea
                  class="focus-ui min-h-[18rem] flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed text-primary outline-none"
                  aria-label={t().extractedFromAria({ filename: resolved().filename })}
                  readOnly
                  spellcheck={false}
                  value={resolved().markdown}
                />
              </>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

export default function DocumentMarkdown() {
  return <DocumentMarkdownView />;
}
