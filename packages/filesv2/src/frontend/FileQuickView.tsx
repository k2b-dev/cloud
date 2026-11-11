import { text } from "@k2b/stdlib";
import {
  Button,
  createDelayedLoading,
  PdfViewer,
  Placeholder,
  QuickView,
  type QuickViewAction,
  type QuickViewItem,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { FileEntry } from "../contracts";
import { hasPdfSignature, PDF_HEADER_WINDOW } from "../pdf-body";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { contentLease, inlinePdfHref, previewKind, readPreview } from "./file-preview";
import { useFilesMessages } from "./messages";
import { loadPreview, prefetchPreview, previewSource, previewUrl, retryPreview } from "./preview-client";

export type FileQuickViewProps = {
  baseId: string;
  locationKey?: string;
  /** The files to step through, in the order the folder shows them. */
  entries: readonly FileEntry[];
  current: string;
  onCurrentChange: (path: string) => void;
  onClose: () => void;
  onDownload: (entry: FileEntry) => void;
  onShare?: (entry: FileEntry) => void;
  /** Opens the editor where the file has one, such as Markdown; the view closes first. */
  onEdit?: (entry: FileEntry) => void;
  editable?: (entry: FileEntry) => boolean;
};

/**
 * Files' large look at one file: Space, Enter, a double-click or the details preview open it, the arrow keys step
 * through the folder. A photo shows its small preview at once, enlarged, and the sharp one fades in on the same frame;
 * PDFs and Office documents (as PDF) read in the PDF viewer; texts, tables, video and audio use the usual preview.
 */
export default function FileQuickView(props: FileQuickViewProps) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const locale = useLocale();
  const entry = (id: string) => props.entries.find((item) => item.path === id);
  const zoomable = (item: FileEntry) => ["image", "pdf", "office"].includes(previewSource(item) ?? "");
  /** Page counts of documents drawn in this view, for the facts after the name. */
  const [pages, setPages] = createSignal<Readonly<Record<string, number>>>({});
  // The neighbours' large previews load in the background, so the arrow keys never wait.
  createEffect(() => {
    const at = props.entries.findIndex((item) => item.path === props.current);
    const timer = setTimeout(() => {
      for (const neighbour of [props.entries[at - 1], props.entries[at + 1]]) if (neighbour) prefetchPreview(props.baseId, neighbour);
    }, 300);
    onCleanup(() => clearTimeout(timer));
  });
  // One item per entry for the view's whole life: a page count that arrives updates the facts in place, so neither the
  // stage nor the film strip mounts again.
  const known = new Map<FileEntry, QuickViewItem>();
  const describe = (item: FileEntry): QuickViewItem => ({
    id: item.path,
    name: item.name,
    get facts() {
      return [
        text.pprintBytes(item.size, { locale: locale() }),
        pages()[item.path] ? t().pageCount(pages()[item.path]!) : null,
        previewSource(item) === "office" ? t().shownAsPdf : null,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    zoomable: zoomable(item),
    thumbnail: () => <FileThumbnail baseId={props.baseId} locationKey={props.locationKey} entry={item} />,
  });
  const items = createMemo(() =>
    props.entries.map((item) => {
      const existing = known.get(item);
      if (existing) return existing;
      const created = describe(item);
      known.set(item, created);
      return created;
    }),
  );
  const actions = (item: QuickViewItem): QuickViewAction[] => {
    const file = entry(item.id);
    if (!file) return [];
    return [
      ...(props.editable?.(file) && props.onEdit
        ? [
            {
              label: file.actions?.write === false ? t().openReadOnly : t().edit,
              icon: "ti ti-pencil",
              onClick: () => props.onEdit?.(file),
            },
          ]
        : []),
      // Safari on iOS shows only the first page of an embedded PDF; the tab opens the whole document at a stable address.
      ...(previewSource(file) === "pdf"
        ? [
            {
              label: t().openInTab,
              icon: "ti ti-external-link",
              onClick: () => window.open(inlinePdfHref(props.baseId, file.path), "_blank", "noopener"),
            },
          ]
        : []),
      { label: f().download, icon: "ti ti-download", onClick: () => props.onDownload(file) },
      ...(props.onShare && file.actions?.share !== false
        ? [{ label: t().shareTitle, icon: "ti ti-share", onClick: () => props.onShare?.(file) }]
        : []),
    ];
  };
  return (
    <QuickView items={items()} current={props.current} onCurrentChange={props.onCurrentChange} onClose={props.onClose} actions={actions}>
      {(item, zoom) => (
        <Show when={entry(item.id)} keyed>
          {(file) => (
            <Stage
              {...props}
              entry={file}
              zoom={zoom}
              onPages={(count) => setPages((all) => (all[file.path] === count ? all : { ...all, [file.path]: count }))}
            />
          )}
        </Show>
      )}
    </QuickView>
  );
}

type StageProps = {
  baseId: string;
  locationKey?: string;
  entry: FileEntry;
  zoom: Accessor<number>;
  onDownload: (entry: FileEntry) => void;
  onPages?: (count: number) => void;
};

function Stage(props: StageProps) {
  const source = previewSource(props.entry);
  return (
    <Switch
      fallback={
        <Show when={previewKind(props.entry)} fallback={<Unavailable {...props} />}>
          <div class="filesv2-quick-reading">
            <FilePreview
              baseId={props.baseId}
              locationKey={props.locationKey}
              entry={props.entry}
              variant="plain"
              headingScale="normal"
              onDownload={() => props.onDownload(props.entry)}
            />
          </div>
        </Show>
      }
    >
      <Match when={source === "image"}>
        <ImageStage {...props} />
      </Match>
      <Match when={source === "pdf" || source === "office"}>
        <DocumentStage {...props} office={source === "office"} />
      </Match>
    </Switch>
  );
}

function Unavailable(props: StageProps) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  return (
    <Placeholder
      class="filesv2-quick-state"
      icon="ti ti-file"
      title={t().noPreview}
      description={t().noPreviewDescription}
      action={
        <Button size="sm" variant="secondary" onClick={() => props.onDownload(props.entry)}>
          <i class="ti ti-download" aria-hidden="true" />
          {f().download}
        </Button>
      }
    />
  );
}

/** The service could not draw this version: the file is fine, so download and a fresh attempt stay one press away. */
function NotMade(props: StageProps & { onRetry: () => void }) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  return (
    <Placeholder
      class="filesv2-quick-state"
      state="error"
      title={t().previewNotMade}
      description={t().previewNotMadeDescription}
      action={
        <div class="filesv2-quick-state__actions">
          <Button size="sm" onClick={props.onRetry}>
            {t().retry}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => props.onDownload(props.entry)}>
            <i class="ti ti-download" aria-hidden="true" />
            {f().download}
          </Button>
        </div>
      }
    />
  );
}

/**
 * The small preview stands at once in the final frame, sized from its own proportions; the sharp one fades in on top,
 * so the frame never changes size. A photo without a preview of its own (too large, or a type the service does not
 * draw) shows the original, as before.
 */
function ImageStage(props: StageProps) {
  const t = useBrowserMessages();
  const abort = new AbortController();
  const urls: string[] = [];
  onCleanup(() => {
    abort.abort();
    for (const url of urls) URL.revokeObjectURL(url);
  });
  const [attempt, setAttempt] = createSignal(0);
  const [ratio, setRatio] = createSignal<number | null>(null);
  const [sharp, setSharp] = createSignal<string>(previewUrl(props.baseId, props.entry, "large"));
  const [ready, setReady] = createSignal(false);
  const [state, setState] = createSignal<"loading" | "shown" | "failed">("loading");
  const placeholder = createDelayedLoading(() => ratio() === null && state() === "loading");
  const measure = (image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && ratio() === null) setRatio(image.naturalWidth / image.naturalHeight);
  };
  const recover = async () => {
    const result = await loadPreview(previewUrl(props.baseId, props.entry, "large"), abort.signal).catch(() => null);
    if (abort.signal.aborted || !result) return;
    if (result.state === "ready") {
      const url = URL.createObjectURL(result.blob);
      urls.push(url);
      setSharp(url);
      return;
    }
    if (result.state === "failed") return void setState("failed");
    try {
      setSharp((await contentLease(props.baseId, props.entry.path, abort.signal, t().previewFailed)).url);
    } catch {
      if (!abort.signal.aborted) setState("failed");
    }
  };
  const retry = async () => {
    setState("loading");
    setReady(false);
    await retryPreview(props.baseId, props.entry).catch(() => {});
    setSharp(previewUrl(props.baseId, props.entry, "large"));
    setAttempt((value) => value + 1);
    void recover();
  };
  return (
    <Show when={state() !== "failed"} fallback={<NotMade {...props} onRetry={() => void retry()} />}>
      <div
        class="filesv2-quick-image"
        classList={{ "k2b-skeleton": placeholder() }}
        data-sized={ratio() === null ? undefined : ""}
        style={{ "--filesv2-quick-ratio": String(ratio() ?? 4 / 3), "--filesv2-quick-zoom": String(props.zoom()) }}
      >
        <Show keyed when={attempt() + 1}>
          {(_attempt) => (
            <img
              class="filesv2-quick-image__low"
              src={previewUrl(props.baseId, props.entry, "small")}
              alt=""
              draggable={false}
              ref={(image) => queueMicrotask(() => image.complete && measure(image))}
              onLoad={(event) => measure(event.currentTarget)}
            />
          )}
        </Show>
        <img
          class="filesv2-quick-image__sharp"
          src={sharp()}
          alt={props.entry.name}
          draggable={false}
          crossOrigin={sharp().startsWith("/") || sharp().startsWith("blob:") ? undefined : "anonymous"}
          referrerPolicy="no-referrer"
          data-ready={ready() ? "" : undefined}
          onLoad={(event) => {
            measure(event.currentTarget);
            setReady(true);
            setState("shown");
          }}
          onError={() => {
            setReady(false);
            if (sharp() === previewUrl(props.baseId, props.entry, "large")) void recover();
            else setState("failed");
          }}
        />
      </div>
    </Show>
  );
}

/**
 * A PDF reads in the PDF viewer, an Office document in its converted PDF. Until the first page is drawn, the large
 * preview of that page holds the place, so the reader sees the document at once.
 */
function DocumentStage(props: StageProps & { office: boolean }) {
  const t = useBrowserMessages();
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const [drawn, setDrawn] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [failed, setFailed] = createSignal(false);
  // Any failure reveals the viewer at once, so its error state replaces the first page instead of hiding behind it.
  const request = (): Promise<Blob> =>
    load().catch((error: unknown) => {
      setDrawn(true);
      throw error;
    });
  const load = async (): Promise<Blob> => {
    if (props.office) {
      const result = await loadPreview(previewUrl(props.baseId, props.entry, "pdf"), abort.signal);
      if (result.state !== "ready") {
        if (!abort.signal.aborted) setFailed(true);
        throw new Error(t().previewNotMade);
      }
      return result.blob;
    }
    const blob = await readPreview(props.baseId, props.entry, abort.signal, t().previewFailed);
    if (!hasPdfSignature(new Uint8Array(await blob.slice(0, PDF_HEADER_WINDOW).arrayBuffer()))) throw new Error(t().notPdf);
    return blob;
  };
  const retry = async () => {
    await retryPreview(props.baseId, props.entry).catch(() => {});
    setFailed(false);
    setAttempt((value) => value + 1);
  };
  return (
    <Show when={!failed()} fallback={<NotMade {...props} onRetry={() => void retry()} />}>
      <div class="filesv2-quick-document" data-drawn={drawn() ? "" : undefined}>
        <Show keyed when={attempt() + 1}>
          {(_attempt) => (
            <PdfViewer
              autoLoad
              title={props.entry.name}
              request={request}
              zoom={false}
              scale={props.zoom()}
              onReady={(document) => {
                setDrawn(true);
                props.onPages?.(document.pages);
              }}
              onError={() => setDrawn(true)}
            />
          )}
        </Show>
        <Show when={!drawn()}>
          <img
            class="filesv2-quick-document__first"
            src={previewUrl(props.baseId, props.entry, "large")}
            alt=""
            draggable={false}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        </Show>
      </div>
    </Show>
  );
}
