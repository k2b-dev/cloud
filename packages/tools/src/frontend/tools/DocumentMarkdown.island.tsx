import { showFileDialog } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Empty, Notice, Pane, Prose, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type DocumentMarkdownMessages, documentMarkdownMessages } from "@/api/document-markdown-messages";
import ToolsScreen from "../ToolsScreen";
import { LiveStatus } from "../tools-status";

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

export const ACCEPTED_DOCUMENTS = ".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,.xlsx,.ods,.csv,.epub";
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

const errorMessage = async (response: Pick<Response, "json" | "status">, t: DocumentMarkdownMessages): Promise<string> => {
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

/**
 * Document to Markdown on v2: one column. The status row says what happens (waiting for a document, converting it,
 * done, or why it failed); "Dokument wählen" is the one deed, and a document dropped anywhere on the page converts
 * as well. The result is a section with the file's name and sizes, its two deeds, and the plain Markdown to read.
 */
export function DocumentMarkdownView(props: DocumentMarkdownViewProps = {}) {
  const locale = useLocale();
  const t = () => documentMarkdownMessages.resolve([locale()]).t;
  const toast = useToast();
  const [selectedFilename, setSelectedFilename] = createSignal(props.initialResult?.filename ?? props.initialFilename ?? "");
  const [result, setResult] = createSignal<DocumentMarkdownResult | null>(props.initialResult ?? null);
  const [error, setError] = createSignal(props.initialError ?? "");
  const [busy, setBusy] = createSignal(props.initialBusy ?? false);
  // a drop that is not converted says so: one while another runs, or the others of several at once
  const [refusal, setRefusal] = createSignal<{ title: string; text: string } | null>(null);
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
    setRefusal(
      files.length > 1 ? { title: t().onlyFirstTitle({ filename: file.name }), text: t().onlyFirst({ count: files.length - 1 }) } : null,
    );
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
  const choose = () =>
    void showFileDialog({ accept: ACCEPTED_DOCUMENTS }).then(
      (file) => convert([file]),
      () => undefined,
    );
  // k2b-ui gap: v2 has no file drop target; the page takes a dropped document itself and the status row says so.
  const [dragging, setDragging] = createSignal(false);
  onMount(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const dropped = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (busy()) setRefusal({ title: t().busyDropTitle({ filename: files[0]!.name }), text: t().busyDrop });
      else void convert(files);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", dropped);
    onCleanup(() => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", dropped);
    });
  });
  const copy = (markdown: string) =>
    void navigator.clipboard.writeText(markdown).then(
      () => toast(t().copied, { status: "ok" }),
      () => toast(t().copyFailed, { status: "bad" }),
    );
  /** What the live region says: converting, converted, or that it failed (the notice says why). */
  const announcement = () =>
    busy()
      ? t().convertingFile({ filename: selectedFilename() })
      : error()
        ? t().conversionFailedTitle
        : result()
          ? t().converted({ filename: result()!.filename })
          : undefined;

  /** What the place of the result says while there is none: converting, a drop on its way, or how to start. */
  const waiting = () =>
    busy() ? t().convertingFile({ filename: selectedFilename() }) : dragging() ? t().dropToConvert : t().previewDescription;

  return (
    <ToolsScreen
      tool="document-markdown"
      item={result()?.filename ?? (busy() ? selectedFilename() : undefined)}
      primary={{ label: t().chooseDocument, icon: "file-upload", onClick: choose, disabled: busy() }}
      end={
        <>
          <Show when={busy()}>
            <Button variant="ghost" icon="x" onClick={cancel}>
              {t().cancel}
            </Button>
          </Show>
          <Button variant="primary" icon="file-upload" busy={busy()} onClick={choose}>
            {t().chooseDocument}
          </Button>
        </>
      }
    >
      <Pane label={t().previewTitle} scrollKey="tools-document-markdown">
        <Canvas label={t().statusLabel}>
          <LiveStatus text={announcement()} />
        </Canvas>
        <Show when={refusal()}>
          {(refused) => (
            <Notice tone="warn" title={refused().title} actions={[{ label: t().hide, onClick: () => setRefusal(null) }]}>
              {refused().text}
            </Notice>
          )}
        </Show>
        <Show when={error()}>
          {(message) => (
            <Notice tone="bad" title={t().conversionFailedTitle} actions={[{ label: t().chooseDocument, onClick: choose }]}>
              {message()}
            </Notice>
          )}
        </Show>
        <Show
          when={result()}
          fallback={
            <Show when={!error()}>
              <Empty
                icon="markdown"
                text={waiting()}
                action={busy() ? undefined : { label: t().chooseDocument, icon: "file-upload", onClick: choose }}
              />
            </Show>
          }
        >
          {(resolved) => (
            <>
              <Show when={resolved().truncated}>
                <Notice tone="warn" title={t().truncatedTitle}>
                  {t().truncatedBody}
                </Notice>
              </Show>
              {/* the source and how it reads, side by side; one under the other on the phone */}
              <Pane.Split>
                <Pane label={t().sourceTitle}>
                  <Section
                    icon="markdown"
                    title={t().sourceTitle}
                    summary={t().resultMeta({
                      filename: resolved().filename,
                      format: resolved().format.toUpperCase(),
                      input: formatBytes(resolved().inputBytes),
                      output: formatBytes(resolved().outputBytes),
                    })}
                    actions={[
                      { label: t().copyMarkdown, icon: "copy", onClick: () => copy(resolved().markdown) },
                      { label: t().downloadMd, icon: "download", onClick: () => downloadMarkdown(resolved()) },
                    ]}
                  >
                    {/* The Markdown is drawn text: a fixed height, so a long document scrolls inside it. */}
                    {/* k2b-ui gap: no v2 code block yet (#4244); the Markdown stands in a Canvas until it lands. */}
                    <Canvas label={t().extractedFromAria({ filename: resolved().filename })} height={560}>
                      <pre
                        tabIndex={0}
                        style={{
                          margin: 0,
                          // the text stands on the pane's 20 px edge, as every row and field does
                          padding: "0 20px",
                          "box-sizing": "border-box",
                          height: "100%",
                          overflow: "auto",
                          "white-space": "pre-wrap",
                          "overflow-wrap": "anywhere",
                          font: "13px/20px var(--k2-font-mono)",
                        }}
                      >
                        {resolved().markdown}
                      </pre>
                    </Canvas>
                  </Section>
                </Pane>
                <Pane label={t().renderedTitle}>
                  <Section icon="eye" title={t().renderedTitle}>
                    <Prose markdown={resolved().markdown} />
                  </Section>
                </Pane>
              </Pane.Split>
            </>
          )}
        </Show>
        {/* what the tool takes and keeps, said once before the first document */}
        <Show when={!result()}>
          <Band>
            <Text type="meta" muted>
              {t().aboutDocuments}
            </Text>
          </Band>
        </Show>
      </Pane>
    </ToolsScreen>
  );
}

export default function DocumentMarkdown() {
  return <DocumentMarkdownView />;
}
