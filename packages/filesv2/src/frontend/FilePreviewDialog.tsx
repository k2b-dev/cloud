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
  toast,
} from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import type { FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import { contentLease, fileIcon, inlinePdfHref, previewKind } from "./file-preview";
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
};

/** Documents, text and audio read in a column; tables, images, PDFs and video get the wide frame. */
const WIDE = new Set(["delimited-text", "image", "pdf", "video"]);
/** These fill the frame's full height instead of growing with their content. */
const FILL = new Set(["image", "pdf", "video"]);

/**
 * The one preview dialog of Files, for every file type: the document's own title, a quiet line with name, size and
 * date, the actions in the header, and the content on the dialog surface without a second frame.
 */
export function openFilePreview(options: FilePreviewDialogOptions) {
  const kind = previewKind(options.entry) ?? "none";
  const classes = [panelDialogPanelClass, "filesv2-preview-dialog"];
  if (WIDE.has(kind)) classes.push("filesv2-preview-dialog--wide");
  if (FILL.has(kind)) classes.push("filesv2-preview-dialog--fill");
  return dialogCore.open<void>((close) => <FilePreviewDialog {...options} close={() => close()} />, {
    ...panelDialogOptions,
    panelClassName: classes.join(" "),
    // Reading comes first: focus starts on the content, so arrow keys and Page Down scroll it at once.
    initialFocus: (dialog) => dialog.querySelector<HTMLElement>(".filesv2-preview-dialog__content"),
  });
}

function FilePreviewDialog(props: FilePreviewDialogOptions & { close: () => void }) {
  const t = useBrowserMessages();
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
          <span class="filesv2-preview-facts">
            <i class={fileIcon(props.entry)} aria-hidden="true" />
            <Show when={documentTitle() !== null}>
              <span class="filesv2-preview-facts__name" title={props.entry.name}>
                {props.entry.name}
              </span>
              {separator()}
            </Show>
            <span>
              <Format.Bytes value={props.entry.size} />
            </span>
            {separator()}
            <span class="filesv2-preview-facts__date">
              <Format.DateTime value={props.entry.modified} />
            </span>
          </span>
        }
        actions={
          <>
            <Show when={kind === "markdown" && props.onEdit}>
              <Button size="sm" variant="secondary" class="filesv2-preview-dialog__edit" onClick={edit}>
                <i class="ti ti-pencil" aria-hidden="true" />
                <span class="filesv2-preview-dialog__edit-label">{props.readOnly ? t().openReadOnly : t().edit}</span>
              </Button>
            </Show>
            <Show when={kind === "text"}>
              <CopyButton size="sm" variant="ghost" text={text() ?? ""} disabled={text() === null} />
            </Show>
            <Show when={kind === "image"}>
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
      {/* A sticky table header would sit under the top fade, so tables scroll without it. */}
      <PanelDialog.Body scrollFade={kind !== "delimited-text"}>
        <div class="filesv2-preview-dialog__content" tabindex="-1">
          <FilePreview
            baseId={props.baseId}
            locationKey={props.locationKey}
            entry={props.entry}
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
        </div>
      </PanelDialog.Body>
      <Show when={lightbox()}>{(image) => <Lightbox images={[image()]} onClose={() => setLightbox(null)} />}</Show>
    </PanelDialog>
  );
}
