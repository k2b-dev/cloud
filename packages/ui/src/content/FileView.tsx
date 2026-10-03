/**
 * FileView — renders one file through a small renderer registry keyed by
 * media type / path. Editing is enabled purely by the presence of `save`;
 * without it every renderer is read-only. IDE-style chrome: editors reuse
 * the markdown editor's surface (toolbar with an in-toolbar save, Ctrl/Cmd+S),
 * previews are quiet paper panels with icon-only actions overlaid top-right.
 * A plain preview drops the panel and sits on its host's surface instead.
 * Custom renderers are passed per instance, which keeps SSR requests and
 * independently mounted applications isolated.
 */

import { mutation } from "@k2b/stdlib/solid";
import {
  type Component,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js";
import { Button } from "../actions/Button";
import { prompts } from "../feedback/prompts";
import { Tooltip } from "../feedback/Tooltip";
import { toast } from "../feedback/toast";
import { MarkdownEditor } from "../inputs/markdown/MarkdownEditor";
import { Select } from "../inputs/Select";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";
import CodeDisplay, { type CodeDisplayLanguage } from "./CodeDisplay";
import { type DelimitedPreferences, decodeDelimitedContent, readDelimitedPreferences } from "./delimited-preferences";
import { type FileViewFile, fileViewExtension, getFileViewPreviewKind, parseDelimitedText } from "./file-view-preview";
import MarkdownView from "./MarkdownView";
import { leadingMarkdownTitle } from "./markdown-title";
import PdfPreview from "./PdfPreview";
import StructuredDataPreview, { type StructuredDataValue } from "./StructuredDataPreview";

export type { FileViewFile, FileViewPreviewKind } from "./file-view-preview";
export { canPreviewFile, getFileViewPreviewKind } from "./file-view-preview";
export type FileViewContent = { encoding: "utf8" | "base64"; content: string; mediaType: string };

export type FileViewProps = {
  /**
   * Plain previews inherit the surrounding surface without a frame or inset padding. They do not scroll on their
   * own, so the host owns scrolling and the actions around them.
   */
  variant?: "default" | "plain";
  /**
   * Lifts a leading Markdown level-one heading into the host, for example a dialog title. Reports its plain text, or
   * null when the shown file has none or fails to load, and leaves that heading out of the preview.
   */
  onDocumentTitle?: (title: string | null) => void;
  /** Read-only excerpt limit; omitted renders the complete preview. */
  previewLines?: number;
  onExpandPreview?: () => void;
  headingScale?: "compact" | "normal" | "large";
  /** Optional browser-local preference scope, owned by the host. */
  previewPreferencesKey?: string;
  file: FileViewFile;
  load: () => Promise<FileViewContent>;
  /** Refetch the current path when this host-owned revision changes. */
  revision?: unknown;
  /** Register an awaitable refresh for the currently visible preview. */
  registerRefresh?: (refresh: () => Promise<void>) => void | (() => void);
  /** Presence enables editing for text-based renderers. */
  save?: (content: string) => Promise<void>;
  /** Authenticated inline URL used by browser-native image, PDF, audio, and video previews. */
  previewHref?: string | null;
  /** CORS mode for native image/audio/video previews. Omit to preserve browser defaults. */
  crossOrigin?: "anonymous" | "use-credentials";
  /** Native media failed to load; the host can renew a signed URL and offer retry. */
  onPreviewError?: () => void;
  /** Download actions only; never a preview source, because an attachment response does not render inline. */
  downloadHref?: string | null;
  /** App-specific renderers matched before the built-ins for this instance. */
  renderers?: readonly FileViewRenderer[];
  /** Reports local edit state so a parent browser can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
};

export type FileViewRendererProps = {
  /** Read-only excerpt limit; omitted renders the complete preview. */
  previewLines?: number;
  onExpandPreview?: () => void;
  headingScale?: "compact" | "normal" | "large";
  /** Optional browser-local preference scope, owned by the host. */
  previewPreferencesKey?: string;
  file: FileViewFile;
  content: FileViewContent;
  previewHref: string | null;
  crossOrigin?: "anonymous" | "use-credentials";
  onPreviewError?: () => void;
  downloadHref: string | null;
  /** Null when the file is read-only. */
  editor: {
    draft: () => string;
    setDraft: (value: string) => void;
    dirty: () => boolean;
    saving: () => boolean;
    save: () => Promise<void>;
  } | null;
};

export type FileViewRenderer = {
  id: string;
  match: (file: FileViewFile, content: FileViewContent) => boolean;
  component: Component<FileViewRendererProps>;
  /** Text renderers that support the edit affordance when `save` is present. */
  editable?: boolean;
};

/** Instance options that reach the built-in renderers without widening the public renderer props. */
const FileViewHost = createContext({ plain: false, liftTitle: false });

const codeLanguage = (path: string): CodeDisplayLanguage => {
  const extension = fileViewExtension(path);
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  if (extension === "tsx") return "tsx";
  if (extension === "js" || extension === "mjs" || extension === "cjs") return "js";
  if (extension === "jsx") return "jsx";
  if (extension === "md" || extension === "markdown") return "md";
  return "text";
};

const isMarkdown = (file: FileViewFile, content: FileViewContent) =>
  content.encoding === "utf8" && getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "markdown";

/** Rendered previews hide a leading YAML frontmatter block — it's metadata, not content. */
const stripFrontmatter = (text: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text.trimStart());
  return match ? text.trimStart().slice(match[0].length) : text;
};

/** Icon-only download link with the shared tooltip, for toolbars that style their own controls. */
function DownloadLink(props: { class: string; href: string; download: string; label: string; icon: string }) {
  let link: HTMLAnchorElement | undefined;
  return (
    <>
      <a ref={link} class={props.class} href={props.href} download={props.download} aria-label={props.label}>
        <i class={props.icon} aria-hidden="true" />
        <span class="k2b-sr-only">{props.label}</span>
      </a>
      <Tooltip content={props.label} target={() => link} />
    </>
  );
}

/** Icon-only action, IDE style — sits in the floating top-right cluster of previews. */
function OverlayAction(props: { icon: string; title: string; onClick?: () => void; href?: string; download?: string }) {
  const classes = "k2b-content-file-view__action";
  return (
    <Show
      when={props.href}
      fallback={
        <Tooltip.Trigger type="button" class={classes} content={props.title} aria-label={props.title} onClick={props.onClick}>
          <i class={`ti ${props.icon}`} aria-hidden="true" />
        </Tooltip.Trigger>
      }
    >
      {(href) => (
        <DownloadLink class={classes} href={href()} download={props.download ?? ""} label={props.title} icon={`ti ${props.icon}`} />
      )}
    </Show>
  );
}

/** Scrollable preview panel with the floating action cluster overlaid top-right. */
function OverlayPanel(props: { actions?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="k2b-content-file-view__panel">
      <div class="k2b-content-file-view__preview">{props.children}</div>
      <Show when={props.actions}>
        <div class="k2b-content-file-view__overlay">{props.actions}</div>
      </Show>
    </div>
  );
}

const DownloadAction = (props: FileViewRendererProps): JSX.Element => {
  const messages = useUiMessages();
  return (
    <Show when={props.downloadHref}>
      {(href) => (
        <OverlayAction
          icon="ti-download"
          title={messages().download}
          href={href()}
          download={props.file.path.slice(props.file.path.lastIndexOf("/") + 1)}
        />
      )}
    </Show>
  );
};

/** Toolbar-styled icon button — reuses the package markdown-editor tool primitive. */
function EditorToolButton(props: { icon: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip.Trigger
      type="button"
      class="k2b-markdown-editor__tool"
      content={props.title}
      aria-label={props.title}
      tabIndex={-1}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      <i class={props.icon} aria-hidden="true" />
    </Tooltip.Trigger>
  );
}

// ── Built-in renderers ──────────────────────────────────────────────────────

function MoreLines(props: { count: number; onClick?: () => void }) {
  const messages = useUiMessages();
  return (
    <Show when={props.count > 0}>
      <div class="k2b-content-file-view__truncated">
        <Show when={props.onClick} fallback={<span>{messages().previewMoreLines(props.count)}</span>}>
          <Button size="sm" variant="ghost" onClick={props.onClick}>
            {messages().previewMoreLines(props.count)}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
function TextExcerpt(props: { renderer: FileViewRendererProps; text: string; markdown?: boolean }) {
  const lines = createMemo(() => props.text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"));
  const limit = () => (props.renderer.previewLines === undefined ? lines().length : Math.max(1, props.renderer.previewLines));
  const text = () => lines().slice(0, limit()).join("\n");
  const host = useContext(FileViewHost);
  // A plain preview has no code box: the host frames the file and owns its copy action.
  const content = () => (
    <Show
      when={props.markdown}
      fallback={<CodeDisplay code={text()} language={codeLanguage(props.renderer.file.path)} copy={host.plain ? false : undefined} />}
    >
      <MarkdownView markdown={text()} headingScale={props.renderer.headingScale ?? "compact"} />
    </Show>
  );
  // Only an excerpt needs a clipping box; a complete preview keeps its content
  // a direct child of the preview frame, which the frame's styles expect.
  return (
    <>
      <Show when={props.renderer.previewLines !== undefined} fallback={content()}>
        <div class="k2b-content-file-view__excerpt">{content()}</div>
      </Show>
      <MoreLines count={lines().length - limit()} onClick={props.renderer.onExpandPreview} />
    </>
  );
}

function MarkdownRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  const host = useContext(FileViewHost);
  const [editing, setEditing] = createSignal(false);
  const markdown = () => {
    const text = stripFrontmatter(props.editor?.draft() ?? props.content.content);
    return host.liftTitle ? (leadingMarkdownTitle(text)?.body ?? text) : text;
  };
  return (
    <Show
      when={props.editor && editing()}
      fallback={
        <OverlayPanel
          actions={
            <>
              <Show when={props.editor}>
                <OverlayAction icon="ti-pencil" title={messages().edit} onClick={() => setEditing(true)} />
              </Show>
              <DownloadAction {...props} />
            </>
          }
        >
          <div class="k2b-content-file-view__document">
            <TextExcerpt renderer={props} text={markdown()} markdown />
          </div>
        </OverlayPanel>
      }
    >
      {(_) => {
        const editor = props.editor!;
        return (
          <div class="k2b-content-file-view__editor">
            <MarkdownEditor
              class="k2b-content-file-view__markdown-field"
              aria-label={`Edit ${props.file.path.slice(props.file.path.lastIndexOf("/") + 1)}`}
              fill
              value={editor.draft()}
              onValueChange={editor.setDraft}
              showStats={false}
              onSave={() => void editor.save()}
              saveDisabled={!editor.dirty()}
              saving={editor.saving()}
              toolbarTrailing={<EditorToolButton icon="ti ti-eye" title={messages().preview} onClick={() => setEditing(false)} />}
            />
          </div>
        );
      }}
    </Show>
  );
}

function TextRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  return (
    <Show
      when={props.editor}
      fallback={
        <OverlayPanel actions={<DownloadAction {...props} />}>
          <TextExcerpt renderer={props} text={props.content.content} />
        </OverlayPanel>
      }
    >
      {(editor) => (
        // Same chrome as the markdown editor — literally the same classes, so
        // border, radius, focus ring, toolbar height and text metrics cannot drift.
        <div class="k2b-content-file-view__editor">
          <div
            class="k2b-markdown-editor"
            data-fill="true"
            role="group"
            aria-label={messages().textEditor}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (editor().dirty() && !editor().saving()) void editor().save();
              }
            }}
          >
            {/* No formatting tools here — the divider under an actions-only bar reads lost. */}
            <div class="k2b-markdown-editor__toolbar k2b-content-file-view__code-toolbar">
              <span class="k2b-content-file-view__code-language">{codeLanguage(props.file.path)}</span>
              <span class="k2b-markdown-editor__trailing">
                <Show when={props.downloadHref}>
                  {(href) => (
                    <DownloadLink
                      class="k2b-markdown-editor__tool"
                      href={href()}
                      download={props.file.path.slice(props.file.path.lastIndexOf("/") + 1)}
                      label={messages().download}
                      icon="ti ti-download"
                    />
                  )}
                </Show>
                <EditorToolButton
                  icon={editor().saving() ? "ti ti-loader-2 k2b-spin" : "ti ti-device-floppy"}
                  title={messages().saveShortcut}
                  disabled={!editor().dirty() || editor().saving()}
                  onClick={() => void editor().save()}
                />
              </span>
            </div>
            <div class="k2b-markdown-editor__surface">
              <textarea
                class="k2b-content-file-view__code-input"
                value={editor().draft()}
                spellcheck={false}
                onInput={(event) => editor().setDraft(event.currentTarget.value)}
              />
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

function JsonRenderer(props: FileViewRendererProps) {
  const parsed = createMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(props.content.content) as StructuredDataValue };
    } catch {
      return { ok: false as const };
    }
  });
  const parsedValue = (): StructuredDataValue => {
    const result = parsed();
    return result.ok ? result.value : null;
  };

  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
      <div class="k2b-content-file-view__document">
        <Show when={parsed().ok} fallback={<TextExcerpt renderer={props} text={props.content.content} />}>
          <Show
            when={props.previewLines === undefined}
            fallback={<TextExcerpt renderer={props} text={JSON.stringify(parsedValue(), null, 2)} />}
          >
            <StructuredDataPreview data={parsedValue()} maxRows={200} />
          </Show>
        </Show>
      </div>
    </OverlayPanel>
  );
}

function DelimitedTextRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  const [preferences, setPreferences] = createSignal<DelimitedPreferences>({ encoding: "utf-8", delimiter: "auto", view: "table" });
  onMount(() => {
    if (!props.previewPreferencesKey) return;
    try {
      setPreferences(readDelimitedPreferences(localStorage.getItem(props.previewPreferencesKey)));
    } catch {
      /* Storage may be disabled. */
    }
  });
  const update = (patch: Partial<DelimitedPreferences>) => {
    const next = { ...preferences(), ...patch };
    setPreferences(next);
    if (props.previewPreferencesKey) {
      try {
        localStorage.setItem(props.previewPreferencesKey, JSON.stringify(next));
      } catch {
        /* Keep the local selection. */
      }
    }
  };
  const text = createMemo(() => decodeDelimitedContent(props.content, preferences().encoding));
  const delimiter = () =>
    preferences().delimiter === "auto"
      ? fileViewExtension(props.file.path) === "tsv" || props.content.mediaType === "text/tab-separated-values"
        ? "\t"
        : ","
      : preferences().delimiter;
  const [page, setPage] = createSignal(0);
  createEffect(() => {
    text();
    delimiter();
    props.previewLines;
    setPage(0);
  });
  const pageSize = () => (props.previewLines === undefined ? 200 : Math.max(1, props.previewLines));
  const preview = createMemo(() => parseDelimitedText(text(), delimiter(), { rows: pageSize() + 1, offset: page() * pageSize() }));
  const settings = () =>
    prompts.dialog(
      () => (
        <div class="k2b-content-file-view__settings">
          <Select
            label={messages().csvEncoding}
            value={preferences().encoding}
            disabled={props.content.encoding !== "base64"}
            options={["utf-8", "windows-1252", "utf-16le", "utf-16be"]}
            onValueChange={(value) => {
              if (value) update({ encoding: value });
            }}
          />
          <Select
            label={messages().csvSeparator}
            value={preferences().delimiter}
            options={[
              { value: "auto", label: messages().csvDefaultSeparator },
              { value: ",", label: messages().csvComma },
              { value: ";", label: messages().csvSemicolon },
              { value: "\t", label: messages().csvTab },
              { value: "|", label: "|" },
            ]}
            onValueChange={(value) => {
              if (value) update({ delimiter: value });
            }}
          />
          <Select
            label={messages().csvView}
            value={preferences().view}
            options={[
              { value: "table", label: messages().dataTable },
              { value: "raw", label: messages().csvRaw },
            ]}
            onValueChange={(value) => {
              if (value === "table" || value === "raw") update({ view: value });
            }}
          />
        </div>
      ),
      { title: messages().csvSettings },
    );
  const headers = createMemo(() => preview().rows[0] ?? []);
  const rows = createMemo(() => preview().rows.slice(1));

  return (
    <OverlayPanel
      actions={
        <>
          <OverlayAction icon="ti-adjustments-horizontal" title={messages().csvSettings} onClick={() => void settings()} />
          <DownloadAction {...props} />
        </>
      }
    >
      <Show when={preferences().view === "table"} fallback={<TextExcerpt renderer={props} text={text()} />}>
        <Show
          when={headers().length > 0}
          fallback={<Placeholder icon="ti ti-table" title={messages().emptyFile} description={messages().delimitedFileEmpty} />}
        >
          <div class="k2b-content-file-view__sheet">
            <table class="k2b-content-file-view__table">
              <thead>
                <tr>
                  <For each={headers()}>
                    {(header, index) => (
                      <th scope="col">
                        <span>{header || messages().column({ number: index() + 1 })}</span>
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr>
                      <For each={headers()}>{(_, index) => <td>{row[index()] ?? ""}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={preview().columnsTruncated}>
              <div class="k2b-content-file-view__truncated">{messages().previewColumnsLimited}</div>
            </Show>
            <Show
              when={props.previewLines !== undefined}
              fallback={
                <Show when={preview().totalRows > 201}>
                  <div class="k2b-content-file-view__pagination">
                    <Button size="sm" variant="ghost" disabled={page() === 0} onClick={() => setPage(page() - 1)}>
                      {messages().previous}
                    </Button>
                    <span>
                      {page() * pageSize() + 1}–{Math.min((page() + 1) * pageSize(), preview().totalRows - 1)} / {preview().totalRows - 1}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={(page() + 1) * pageSize() >= preview().totalRows - 1}
                      onClick={() => setPage(page() + 1)}
                    >
                      {messages().next}
                    </Button>
                  </div>
                </Show>
              }
            >
              <MoreLines count={preview().totalRows - rows().length - 1} onClick={props.onExpandPreview} />
            </Show>
          </div>
        </Show>
      </Show>
    </OverlayPanel>
  );
}

const mediaSource = (props: FileViewRendererProps): string =>
  props.previewHref ?? `data:${props.content.mediaType};base64,${props.content.content}`;

function ImageRenderer(props: FileViewRendererProps) {
  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
      <div class="k2b-content-file-view__media">
        <img crossOrigin={props.crossOrigin} onError={props.onPreviewError} src={mediaSource(props)} alt={props.file.path} />
      </div>
    </OverlayPanel>
  );
}

const pdfBlob = (content: FileViewContent): Blob => {
  if (content.encoding === "utf8") return new Blob([content.content], { type: "application/pdf" });
  const binary = atob(content.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "application/pdf" });
};

/**
 * A host inline URL goes to the browser's native viewer. Without one, the
 * loaded bytes become a local PDF Blob: a download URL is an attachment and
 * would leave a native viewer empty.
 */
function PdfRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  // A new Blob remounts the preview, so changed bytes show the new file. A revision refetch
  // often returns the same bytes (the Assistant refetches on every tool step); keeping the
  // Blob then keeps the reader's page instead of reloading the viewer.
  const bytes = createMemo(() => props.content, undefined, {
    equals: (previous, next) => previous.encoding === next.encoding && previous.content === next.content,
  });
  const blob = createMemo(() => (props.previewHref || !bytes().content ? null : pdfBlob(bytes())));
  return (
    <Show
      when={props.previewHref}
      fallback={
        <Show
          keyed
          when={blob()}
          fallback={<Placeholder icon="ti ti-file-type-pdf" title="PDF" description={messages().noInlinePreview} />}
        >
          {(pdf) => (
            // Composed without the standalone heading: the host already names the file, and the frame keeps the
            // file name as its accessible title.
            <PdfPreview autoLoad title={props.file.path.slice(props.file.path.lastIndexOf("/") + 1)} request={async () => pdf}>
              {(parts) => (
                <div class="k2b-content-file-view__pdf-viewer">
                  {parts.actions}
                  {parts.content}
                </div>
              )}
            </PdfPreview>
          )}
        </Show>
      }
    >
      {(href) => <object data={href()} type="application/pdf" class="k2b-content-file-view__pdf" aria-label={props.file.path} />}
    </Show>
  );
}

function AudioRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
      <div class="k2b-content-file-view__media" data-kind="audio">
        <audio
          crossOrigin={props.crossOrigin}
          onError={props.onPreviewError}
          controls
          preload="metadata"
          src={mediaSource(props)}
          aria-label={props.file.path}
        >
          {messages().audioUnsupported}
        </audio>
      </div>
    </OverlayPanel>
  );
}

function VideoRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
      <div class="k2b-content-file-view__media" data-kind="video">
        <video
          crossOrigin={props.crossOrigin}
          onError={props.onPreviewError}
          controls
          preload="metadata"
          playsinline
          src={mediaSource(props)}
          aria-label={props.file.path}
        >
          {messages().videoUnsupported}
        </video>
      </div>
    </OverlayPanel>
  );
}

function BinaryRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  return (
    <Placeholder
      icon="ti ti-file-unknown"
      title={messages().noPreview}
      description={props.content.mediaType || messages().binaryFile}
      action={
        <Show when={props.downloadHref}>
          {(href) => (
            <a class="k2b-button" data-variant="secondary" data-size="sm" href={href()} download="">
              <i class="ti ti-download" aria-hidden="true" />
              {messages().download}
            </a>
          )}
        </Show>
      }
    />
  );
}

const BUILTIN_RENDERERS: FileViewRenderer[] = [
  { id: "markdown", match: isMarkdown, component: MarkdownRenderer, editable: true },
  {
    id: "image",
    match: (file, content) => getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "image",
    component: ImageRenderer,
  },
  {
    id: "pdf",
    match: (file, content) => getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "pdf",
    component: PdfRenderer,
  },
  {
    id: "json",
    match: (file, content) =>
      content.encoding === "utf8" && getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "json",
    component: JsonRenderer,
  },
  {
    id: "delimited-text",
    match: (file, content) => getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "delimited-text",
    component: DelimitedTextRenderer,
  },
  {
    id: "audio",
    match: (file, content) => getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "audio",
    component: AudioRenderer,
  },
  {
    id: "video",
    match: (file, content) => getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "video",
    component: VideoRenderer,
  },
  { id: "text", match: (_file, content) => content.encoding === "utf8", component: TextRenderer, editable: true },
  { id: "binary", match: () => true, component: BinaryRenderer },
];

// ── Component ───────────────────────────────────────────────────────────────

export const formatFileViewSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function FileView(props: FileViewProps) {
  const messages = useUiMessages();
  const [draft, setDraft] = createSignal("");
  const [savedDraft, setSavedDraft] = createSignal("");
  const [nativeRevision, setNativeRevision] = createSignal(0);
  const dirty = createMemo(() => draft() !== savedDraft());
  const instanceRenderers = () => props.renderers ?? [];
  const saveMutation = mutation.create<{ path: string; content: string }, { path: string; content: string }>({
    mutation: async (input) => {
      await props.save!(input.content);
      return input;
    },
    onSuccess: (saved) => {
      if (props.file.path === saved.path) setSavedDraft(saved.content);
      toast.success(messages().fileSaved);
    },
    onError: (error) => toast.error(error.message),
  });
  const nativePreviewHref = createMemo(() => {
    const href = props.previewHref;
    if (!href) return null;
    const separator = href.includes("?") ? "&" : "?";
    return `${href}${separator}preview-revision=${nativeRevision()}`;
  });
  const browserPreviewContent = createMemo<FileViewContent | null>(() => {
    const kind = getFileViewPreviewKind(props.file);
    if (kind !== "image" && kind !== "pdf" && kind !== "audio" && kind !== "video") return null;
    const href = nativePreviewHref();
    if (!href) return null;

    const candidate: FileViewContent = {
      encoding: "base64",
      content: "",
      mediaType: props.file.mediaType ?? "application/octet-stream",
    };
    return instanceRenderers().some((renderer) => renderer.match(props.file, candidate)) ? null : candidate;
  });
  const [content, { refetch }] = createResource(
    () => (browserPreviewContent() ? null : { path: props.file.path, revision: props.revision }),
    async () => {
      saveMutation.abort();
      // `load` is an imperative source adapter. Host signal reads inside it
      // must not turn this resource into a hidden reactive feedback loop.
      const loaded = await untrack(() => props.load());
      const loadedDraft = loaded.encoding === "utf8" ? loaded.content : "";
      setDraft(loadedDraft);
      setSavedDraft(loadedDraft);
      return loaded;
    },
  );
  createEffect(() => {
    if (!props.registerRefresh) return;
    const unregister = props.registerRefresh(async () => {
      if (browserPreviewContent()) setNativeRevision((value) => value + 1);
      else await refetch();
    });
    if (unregister) onCleanup(unregister);
  });
  // An errored resource throws when read; the error state below shows it instead.
  const resolvedContent = createMemo(() => browserPreviewContent() ?? (content.error ? undefined : content()));

  const renderer = createMemo(() => {
    const loaded = resolvedContent();
    if (!loaded) return null;
    return [...instanceRenderers(), ...BUILTIN_RENDERERS].find((candidate) => candidate.match(props.file, loaded)) ?? null;
  });

  createEffect(() => {
    props.onDirtyChange?.(dirty());
  });

  // Undefined while loading; the host keeps its own placeholder until the shown file decides.
  const documentTitle = createMemo<string | null | undefined>(() => {
    if (!props.onDocumentTitle) return undefined;
    if (content.error) return null;
    const loaded = resolvedContent();
    if (!loaded) return undefined;
    if (renderer()?.component !== MarkdownRenderer) return null;
    return leadingMarkdownTitle(stripFrontmatter(editor()?.draft() ?? loaded.content))?.title ?? null;
  });
  createEffect(() => {
    const title = documentTitle();
    if (title !== undefined) props.onDocumentTitle?.(title);
  });

  const save = async () => {
    if (!props.save || saveMutation.loading()) return;
    await saveMutation.mutate({ path: props.file.path, content: draft() });
  };

  const editor = () =>
    props.save && renderer()?.editable && resolvedContent()?.encoding === "utf8"
      ? {
          draft,
          setDraft,
          dirty,
          saving: saveMutation.loading,
          save,
        }
      : null;

  return (
    <div
      class={`k2b-content-file-view ${props.class ?? ""}`}
      data-variant={props.variant}
      data-excerpt={props.previewLines !== undefined ? "true" : undefined}
    >
      <FileViewHost.Provider
        value={{
          get plain() {
            return props.variant === "plain";
          },
          get liftTitle() {
            return Boolean(props.onDocumentTitle);
          },
        }}
      >
        <Switch>
          <Match when={content.loading && content() === undefined}>
            <Placeholder icon="ti ti-loader-2" title={messages().loading} />
          </Match>
          <Match when={content.error}>
            <Placeholder icon="ti ti-alert-circle" title={messages().failedLoadFile} description={String(content.error?.message ?? "")} />
          </Match>
          <Match when={resolvedContent() && renderer()}>
            {(active) => {
              const Renderer = active().component;
              return (
                <Renderer
                  previewLines={props.previewLines}
                  onExpandPreview={props.onExpandPreview}
                  headingScale={props.headingScale}
                  previewPreferencesKey={props.previewPreferencesKey}
                  file={props.file}
                  content={resolvedContent()!}
                  previewHref={nativePreviewHref()}
                  crossOrigin={props.crossOrigin}
                  onPreviewError={props.onPreviewError}
                  downloadHref={props.downloadHref ?? null}
                  editor={editor()}
                />
              );
            }}
          </Match>
        </Switch>
      </FileViewHost.Provider>
    </div>
  );
}
