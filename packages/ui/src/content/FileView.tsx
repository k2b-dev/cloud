/**
 * FileView — renders one file through a small renderer registry keyed by
 * media type / path. Editing is enabled purely by the presence of `save`;
 * without it every renderer is read-only. IDE-style chrome: editors reuse
 * the markdown editor's surface (toolbar with an in-toolbar save, Ctrl/Cmd+S),
 * previews are quiet paper panels with icon-only actions overlaid top-right.
 * Custom renderers are passed per instance, which keeps SSR requests and
 * independently mounted applications isolated.
 */

import { mutation } from "@k2b/stdlib/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { toast } from "../feedback/toast";
import { MarkdownEditor } from "../inputs/markdown/MarkdownEditor";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";
import CodeDisplay, { type CodeDisplayLanguage } from "./CodeDisplay";
import { type FileViewFile, fileViewExtension, getFileViewPreviewKind, parseDelimitedText } from "./file-view-preview";
import MarkdownView from "./MarkdownView";
import StructuredDataPreview, { type StructuredDataValue } from "./StructuredDataPreview";

export type { FileViewFile, FileViewPreviewKind } from "./file-view-preview";
export { canPreviewFile, getFileViewPreviewKind } from "./file-view-preview";
export type FileViewContent = { encoding: "utf8" | "base64"; content: string; mediaType: string };

export type FileViewProps = {
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
  downloadHref?: string | null;
  /** App-specific renderers matched before the built-ins for this instance. */
  renderers?: readonly FileViewRenderer[];
  /** Reports local edit state so a parent browser can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
};

export type FileViewRendererProps = {
  file: FileViewFile;
  content: FileViewContent;
  previewHref: string | null;
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

/** Icon-only action, IDE style — sits in the floating top-right cluster of previews. */
function OverlayAction(props: { icon: string; title: string; onClick?: () => void; href?: string; download?: string }) {
  const classes = "k2b-content-file-view__action";
  return (
    <Show
      when={props.href}
      fallback={
        <button type="button" class={classes} title={props.title} aria-label={props.title} onClick={props.onClick}>
          <i class={`ti ${props.icon}`} aria-hidden="true" />
        </button>
      }
    >
      {(href) => (
        <a class={classes} href={href()} download={props.download ?? ""} title={props.title} aria-label={props.title}>
          <i class={`ti ${props.icon}`} aria-hidden="true" />
          <span class="k2b-sr-only">{props.title}</span>
        </a>
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
    <button
      type="button"
      class="k2b-markdown-editor__tool"
      title={props.title}
      aria-label={props.title}
      tabIndex={-1}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      <i class={props.icon} />
    </button>
  );
}

// ── Built-in renderers ──────────────────────────────────────────────────────

function MarkdownRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  const [editing, setEditing] = createSignal(false);
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
            <MarkdownView markdown={stripFrontmatter(props.editor?.draft() ?? props.content.content)} headingScale="compact" />
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
          <CodeDisplay code={props.content.content} language={codeLanguage(props.file.path)} />
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
                    <a
                      class="k2b-markdown-editor__tool"
                      href={href()}
                      download={props.file.path.slice(props.file.path.lastIndexOf("/") + 1)}
                      title={messages().download}
                      aria-label={messages().download}
                    >
                      <i class="ti ti-download" />
                    </a>
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
        <Show when={parsed().ok} fallback={<CodeDisplay code={props.content.content} language="text" />}>
          <StructuredDataPreview data={parsedValue()} maxRows={200} />
        </Show>
      </div>
    </OverlayPanel>
  );
}

function DelimitedTextRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  const delimiter = () =>
    fileViewExtension(props.file.path) === "tsv" || props.content.mediaType === "text/tab-separated-values" ? "\t" : ",";
  const preview = createMemo(() => parseDelimitedText(props.content.content, delimiter()));
  const headers = createMemo(() => preview().rows[0] ?? []);
  const rows = createMemo(() => preview().rows.slice(1));

  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
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
          <Show when={preview().truncated}>
            <p class="k2b-content-file-view__truncated">{messages().previewLimited}</p>
          </Show>
        </div>
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
        <img src={mediaSource(props)} alt={props.file.path} />
      </div>
    </OverlayPanel>
  );
}

function PdfRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  const href = () => props.previewHref ?? props.downloadHref;
  return (
    <Show when={href()} fallback={<Placeholder icon="ti ti-file-type-pdf" title="PDF" description={messages().noInlinePreview} />}>
      {(href) => <object data={href()} type="application/pdf" class="k2b-content-file-view__pdf" aria-label={props.file.path} />}
    </Show>
  );
}

function AudioRenderer(props: FileViewRendererProps) {
  const messages = useUiMessages();
  return (
    <OverlayPanel actions={<DownloadAction {...props} />}>
      <div class="k2b-content-file-view__media" data-kind="audio">
        <audio controls preload="metadata" src={mediaSource(props)} aria-label={props.file.path}>
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
        <video controls preload="metadata" playsinline src={mediaSource(props)} aria-label={props.file.path}>
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
    match: (file, content) =>
      content.encoding === "utf8" &&
      getFileViewPreviewKind({ ...file, mediaType: content.mediaType || file.mediaType }) === "delimited-text",
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
    const kind = getFileViewPreviewKind(props.file);
    const href = props.previewHref ?? (kind === "pdf" ? props.downloadHref : null);
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
  const resolvedContent = createMemo(() => browserPreviewContent() ?? content());

  const renderer = createMemo(() => {
    const loaded = resolvedContent();
    if (!loaded) return null;
    return [...instanceRenderers(), ...BUILTIN_RENDERERS].find((candidate) => candidate.match(props.file, loaded)) ?? null;
  });

  createEffect(() => {
    props.onDirtyChange?.(dirty());
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
    <div class={`k2b-content-file-view ${props.class ?? ""}`}>
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
                file={props.file}
                content={resolvedContent()!}
                previewHref={nativePreviewHref()}
                downloadHref={props.downloadHref ?? null}
                editor={editor()}
              />
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}
