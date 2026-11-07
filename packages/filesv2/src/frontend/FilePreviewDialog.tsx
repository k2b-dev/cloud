import {
  Button,
  CopyButton,
  dialogCore,
  Format,
  IconButton,
  IconButtonLink,
  Lightbox,
  type LightboxImage,
  PanelDialog,
  panelDialogOptions,
  panelDialogPanelClass,
  prompts,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { EntryResult, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import FileImageEditor from "./FileImageEditor";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { contentLease, fileIcon, inlinePdfHref, previewKind } from "./file-preview";
import { useImageMessages } from "./image-messages";
import { useFilesMessages } from "./messages";

export type FilePreviewDialogOptions = {
  baseId: string;
  locationKey?: string;
  entry: FileEntry;
  onDownload: () => void;
  /** Opens the Markdown editor; offered for Markdown files only. */
  onEdit?: () => void;
  /** The editor opens read-only, so the action says so. */
  readOnly?: boolean;
  onNotPdf?: () => void;
  imageEditing?: { canCreate: boolean; onSaved: (result: EntryResult) => void };
  /** The folder's or selection's entries; its images form the strip while editing. */
  images?: readonly FileEntry[];
};

/** Documents, text and audio read in a column; tables, images, PDFs and video get the wide frame. */
const WIDE = new Set(["delimited-text", "image", "pdf", "video"]);
/** These fill the frame's full height instead of growing with their content. */
const FILL = new Set(["image", "pdf", "video"]);
/** These take the body's height; a table then scrolls inside it, so its header row and settings stay in view. */
const STRETCH = new Set(["delimited-text", ...FILL]);

/**
 * The one preview dialog of Files, for every file type: the document's own title, a quiet line with name, size and
 * date, the actions in the header, and the content on the dialog surface without a second frame.
 */
export function openFilePreview(options: FilePreviewDialogOptions) {
  const kind = previewKind(options.entry) ?? "none";
  const classes = [panelDialogPanelClass, "filesv2-preview-dialog"];
  if (WIDE.has(kind)) classes.push("filesv2-preview-dialog--wide");
  if (FILL.has(kind)) classes.push("filesv2-preview-dialog--fill");
  if (STRETCH.has(kind)) classes.push("filesv2-preview-dialog--stretch");
  return dialogCore.open<void>(
    (close, context) => {
      let guard: (() => Promise<boolean>) | null = null;
      const dismiss = async () => {
        if (!guard || (await guard())) close();
      };
      context.setDismissHandler(dismiss);
      return (
        <FilePreviewDialog
          {...options}
          close={() => void context.requestDismiss()}
          setGuard={(next) => {
            guard = next;
          }}
        />
      );
    },
    {
      ...panelDialogOptions,
      panelClassName: classes.join(" "),
      // Reading comes first: focus starts on the content, so arrow keys and Page Down scroll it at once.
      initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".filesv2-preview-dialog__content"),
    },
  );
}

function FilePreviewDialog(
  props: FilePreviewDialogOptions & { close: () => void; setGuard: (guard: (() => Promise<boolean>) | null) => void },
) {
  const t = useBrowserMessages();
  const i = useImageMessages();
  const [editing, setEditing] = createSignal(false);
  const [entry, setEntry] = createSignal(props.entry);
  const f = useFilesMessages();
  const kind = previewKind(props.entry);
  // Undefined until a Markdown file shows whether it starts with a heading; every other file is titled by its name.
  const [documentTitle, setDocumentTitle] = createSignal<string | null | undefined>(kind === "markdown" ? undefined : null);
  const [text, setText] = createSignal<string | null>(null);
  const [notPdf, setNotPdf] = createSignal(false);
  const [lightbox, setLightbox] = createSignal<LightboxImage | null>(null);
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  let opening = false;
  // A fresh address for the full-screen view; the inline preview's lease may be close to expiry.
  const openLightbox = async () => {
    if (opening) return;
    opening = true;
    try {
      const lease = await contentLease(props.baseId, props.entry.path, abort.signal, t().previewFailed);
      if (!abort.signal.aborted) setLightbox({ src: lease.url, alt: props.entry.name });
    } catch (error) {
      if (!abort.signal.aborted) toast.error(error instanceof Error ? error.message : t().previewFailed);
    } finally {
      opening = false;
    }
  };
  const edit = () => {
    props.close();
    props.onEdit?.();
  };
  // Image editing: one session per opened image of the folder; the dialog guards them together.
  const [editPath, setEditPath] = createSignal(props.entry.path);
  const [sessions, setSessions] = createSignal<string[]>([]);
  const [statuses, setStatuses] = createSignal(new Map<string, { dirty: boolean; busy: boolean }>());
  const images = () => (props.images ?? []).filter((image) => previewKind(image) === "image");
  const entryAt = (path: string) => (path === props.entry.path ? entry() : images().find((image) => image.path === path));
  const stripItems = () =>
    images().length > 1
      ? images().map((image) => ({
          id: image.path,
          name: image.name,
          dirty: statuses().get(image.path)?.dirty ?? false,
          thumbnail: () => <FileThumbnail baseId={props.baseId} locationKey={props.locationKey} entry={image} />,
        }))
      : undefined;
  const openImage = (path: string) => {
    setSessions((open) => (open.includes(path) ? open : [...open, path]));
    setEditPath(path);
  };
  const startEditing = () => {
    openImage(props.entry.path);
    setEditing(true);
  };
  let confirmation: Promise<boolean> | undefined;
  /** Closing loses every unsaved image, so it asks once; an image still saving keeps the dialog open. */
  const guard = async (except?: string) => {
    const open = [...statuses()].filter(([path]) => path !== except).map(([, status]) => status);
    if (open.some((status) => status.busy)) return false;
    if (!open.some((status) => status.dirty)) return true;
    confirmation ??= prompts
      .confirm(i().discard, { variant: "danger" })
      .then(Boolean)
      .finally(() => {
        confirmation = undefined;
      });
    return confirmation;
  };
  props.setGuard(() => guard());
  // The editor itself already confirmed its own image before it asks to leave.
  const leaveEditing = async (from: string) => {
    if (!(await guard(from))) return;
    setEditing(false);
    setSessions([]);
    setStatuses(new Map());
  };
  createEffect(() => {
    const panel = content?.closest<HTMLElement>(".filesv2-preview-dialog");
    if (panel) panel.toggleAttribute("data-editing", editing());
  });
  let content: HTMLDivElement | undefined;
  const separator = () => (
    <span class="filesv2-preview-facts__separator" aria-hidden="true">
      ·
    </span>
  );
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={
          <Show
            when={documentTitle() !== undefined}
            fallback={
              <>
                <span class="k2b-sr-only">{props.entry.name}</span>
                <span class="filesv2-preview-dialog__title-pending" aria-hidden="true" />
              </>
            }
          >
            {documentTitle() ?? props.entry.name}
          </Show>
        }
        subtitle={
          // Held invisibly until the title is known, then shown with it, so nothing visible moves when it arrives.
          <span class="filesv2-preview-facts" data-pending={documentTitle() === undefined ? "" : undefined}>
            <i class={fileIcon(props.entry)} aria-hidden="true" />
            <Show when={documentTitle()}>
              <span class="filesv2-preview-facts__name" title={props.entry.name}>
                {props.entry.name}
              </span>
              {separator()}
            </Show>
            <span class="filesv2-preview-facts__size">
              <Format.Bytes value={entry().size} />
            </span>
            {separator()}
            {/* Phones show the day only, so the date stays readable next to the name and size. */}
            <span class="filesv2-preview-facts__date">
              <Format.DateTime class="filesv2-preview-facts__date-time" value={entry().modified} />
              <Format.Date class="filesv2-preview-facts__date-day" value={entry().modified} />
            </span>
          </span>
        }
        actions={
          <>
            <Show when={kind === "image" && props.imageEditing && !editing()}>
              <Button size="sm" variant="secondary" onClick={startEditing}>
                {i().edit}
              </Button>
            </Show>
            <Show when={kind === "markdown" && props.onEdit}>
              <Button size="sm" variant="secondary" class="filesv2-preview-dialog__edit" onClick={edit}>
                <i class="ti ti-pencil" aria-hidden="true" />
                <span class="filesv2-preview-dialog__edit-label">{props.readOnly ? t().openReadOnly : t().edit}</span>
              </Button>
            </Show>
            <Show when={kind === "text"}>
              <CopyButton size="sm" variant="ghost" text={text() ?? ""} disabled={text() === null} />
            </Show>
            <Show when={kind === "image" && !editing()}>
              <IconButton size="sm" label={t().fullscreen} onClick={() => void openLightbox()}>
                <i class="ti ti-arrows-maximize" aria-hidden="true" />
              </IconButton>
            </Show>
            {/* Safari on iOS shows only the first page of an embedded PDF; the new tab opens the whole document at a
                stable address, so it reloads and keeps its file name. */}
            <Show when={kind === "pdf" && !notPdf()}>
              <IconButtonLink
                size="sm"
                label={t().openInTab}
                href={inlinePdfHref(props.baseId, props.entry.path)}
                target="_blank"
                rel="noopener"
              >
                <i class="ti ti-external-link" aria-hidden="true" />
              </IconButtonLink>
            </Show>
            <IconButton size="sm" label={f().download} onClick={props.onDownload}>
              <i class="ti ti-download" aria-hidden="true" />
            </IconButton>
          </>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <div ref={content} class="filesv2-preview-dialog__content" tabindex="-1">
          <Show
            when={editing()}
            fallback={
              <FilePreview
                baseId={props.baseId}
                locationKey={props.locationKey}
                entry={entry()}
                variant="plain"
                headingScale="normal"
                onDownload={props.onDownload}
                onNotPdf={() => {
                  setNotPdf(true);
                  props.onNotPdf?.();
                }}
                onDocumentTitle={setDocumentTitle}
                onText={setText}
              />
            }
          >
            {/* Every opened image keeps its own session, so switching in the strip never drops unsaved edits. */}
            <For each={sessions()}>
              {(path) => (
                <div class="filesv2-image-session" hidden={path !== editPath()}>
                  <FileImageEditor
                    baseId={props.baseId}
                    path={path}
                    canCreate={props.imageEditing?.canCreate ?? false}
                    canWrite={entryAt(path)?.actions?.write === true}
                    items={stripItems()}
                    onSelectItem={openImage}
                    onStatus={(status) =>
                      setStatuses((all) => {
                        const next = new Map(all);
                        next.set(path, status);
                        return next;
                      })
                    }
                    onBack={() => void leaveEditing(path)}
                    onSaved={(saved) => {
                      if (saved.entry.path === props.entry.path) setEntry(saved.entry);
                      props.imageEditing?.onSaved(saved);
                    }}
                  />
                </div>
              )}
            </For>
          </Show>
        </div>
      </PanelDialog.Body>
      <Show when={lightbox()}>{(image) => <Lightbox images={[image()]} onClose={() => setLightbox(null)} />}</Show>
    </PanelDialog>
  );
}
