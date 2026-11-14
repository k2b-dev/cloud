import { Button, createDelayedLoading, PdfViewer, Skeleton } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import type { FileProviderEntry } from "../contracts/file-provider";
import type { fileChooserMessages } from "./file-chooser-messages";
import { type FileProviderCaller, type FileProviderSource, readProviderFile } from "./file-providers";

type Messages = ReturnType<typeof fileChooserMessages.resolve>["t"];
type FileEntry = Extract<FileProviderEntry, { kind: "file" }>;
export type PreviewKind = "pdf" | "image";

/** Raster images a browser draws directly; SVG is active content and never previewed. */
const IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp|avif)$/;
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|avif)$/i;
/** The selection must rest this long before its bytes are read, so arrowing through a folder reads nothing. */
const PREVIEW_SETTLE_MS = 250;

/** What the chooser can show of a file before reading it: a PDF, an image, or only its icon and facts. */
export const previewKind = (entry: FileEntry): PreviewKind | undefined => {
  const type = entry.mediaType?.toLowerCase() ?? "";
  if (type === "application/pdf" || /\.pdf$/i.test(entry.name)) return "pdf";
  if (IMAGE_TYPE.test(type) || IMAGE_NAME.test(entry.name)) return "image";
  return undefined;
};

/** Whether the bytes a read proved fit the preview: the provider's claim alone never draws a file. */
const fits = (kind: PreviewKind, file: File) => (kind === "pdf" ? file.type === "application/pdf" : IMAGE_TYPE.test(file.type));

/**
 * The preview column of the file chooser for the file in focus: a PDF's whole first page, an image, or the file's
 * icon. Only PDFs and images are read, through the provider's read stream with the chooser's limits, after the focus
 * rested; a read that finishes hands its file to `onRead`, so Add can reuse it. Other files keep the same frame, which
 * Office previews can fill later.
 */
export function FileChooserPreview(props: {
  entry: FileEntry | undefined;
  provider: FileProviderSource | undefined;
  caller: () => FileProviderCaller;
  maxBytes: number;
  accept?: string;
  /** Why the file cannot be chosen; such a file is not read. */
  blocked: boolean;
  /** A file read earlier, such as the last preview, which needs no second read. */
  known: (entry: FileEntry) => File | undefined;
  onRead: (entry: FileEntry, file: File) => void;
  icon: (entry: FileEntry) => string;
  t: () => Messages;
  /** The file's name and facts below the frame. */
  children?: JSX.Element;
}): JSX.Element {
  // One preview per file and provider: a new focus disposes the earlier read and its object URL.
  const key = () => (props.entry && props.provider ? JSON.stringify([props.provider.appId, props.entry.id]) : "");
  return (
    <div class="cloud-file-preview">
      <Show
        when={key()}
        keyed
        fallback={
          <div class="cloud-file-preview__frame" data-state="empty">
            <i class="ti ti-file-search" aria-hidden="true" />
            <span>{props.t().previewEmpty}</span>
          </div>
        }
      >
        {(_key) => {
          // Captured once per key: the keyed block re-runs for every other file.
          const entry = props.entry!;
          const provider = props.provider!;
          const kind = previewKind(entry);
          return (
            <Show
              when={kind && !props.blocked}
              fallback={
                <div class="cloud-file-preview__frame" data-state="icon">
                  <span class="cloud-file-preview__icon" aria-hidden="true">
                    <i class={props.icon(entry)} />
                  </span>
                </div>
              }
            >
              <PreviewRead
                entry={entry}
                provider={provider}
                kind={kind!}
                caller={props.caller}
                maxBytes={props.maxBytes}
                accept={props.accept}
                known={props.known}
                onRead={props.onRead}
                icon={props.icon}
                t={props.t}
              />
            </Show>
          );
        }}
      </Show>
      {props.children}
    </div>
  );
}

function PreviewRead(props: {
  entry: FileEntry;
  provider: FileProviderSource;
  kind: PreviewKind;
  caller: () => FileProviderCaller;
  maxBytes: number;
  accept?: string;
  known: (entry: FileEntry) => File | undefined;
  onRead: (entry: FileEntry, file: File) => void;
  icon: (entry: FileEntry) => string;
  t: () => Messages;
}): JSX.Element {
  const kept = props.known(props.entry);
  const [file, setFile] = createSignal<File | undefined>(kept);
  const [state, setState] = createSignal<"loading" | "ready" | "error">(kept ? "ready" : "loading");
  const placeholder = createDelayedLoading(() => state() === "loading");
  let reading: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(timer);
    reading?.abort();
  });
  const read = (wait: number) => {
    clearTimeout(timer);
    reading?.abort();
    setState("loading");
    timer = setTimeout(async () => {
      const pending = new AbortController();
      reading = pending;
      try {
        const read = await readProviderFile(props.provider, props.entry, {
          ...props.caller(),
          maxBytes: props.maxBytes,
          accept: props.accept,
          signal: pending.signal,
        });
        if (pending.signal.aborted) return;
        setFile(read);
        setState("ready");
        props.onRead(props.entry, read);
      } catch {
        if (!pending.signal.aborted) setState("error");
      }
    }, wait);
  };
  if (!kept) read(PREVIEW_SETTLE_MS);
  const shown = createMemo(() => {
    const value = file();
    return value && fits(props.kind, value) ? value : undefined;
  });
  const imageUrl = createMemo(() => {
    const value = shown();
    if (!value || props.kind !== "image") return undefined;
    const url = URL.createObjectURL(value);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  return (
    <Switch>
      <Match when={state() === "loading"}>
        <div class="cloud-file-preview__frame" data-state="loading" aria-busy="true">
          <Show when={placeholder()}>
            <Skeleton class="cloud-file-preview__skeleton" />
            <span class="k2b-sr-only" role="status">
              {props.t().previewLoading}
            </span>
          </Show>
        </div>
      </Match>
      <Match when={state() === "error" || (state() === "ready" && !shown())}>
        <div class="cloud-file-preview__frame" data-state="icon">
          <span class="cloud-file-preview__icon" aria-hidden="true">
            <i class={props.icon(props.entry)} />
          </span>
          <span>{props.t().previewFailed}</span>
          <Show when={state() === "error"}>
            <Button size="sm" variant="link" onClick={() => read(0)}>
              {props.t().previewRetry}
            </Button>
          </Show>
        </div>
      </Match>
      <Match when={props.kind === "pdf" && shown()}>
        {(pdf) => (
          <div class="cloud-file-preview__frame" data-state="pdf">
            <PdfViewer title={props.entry.name} data={pdf()} fit="page" zoom={false} />
          </div>
        )}
      </Match>
      <Match when={imageUrl()}>
        {(url) => (
          <div class="cloud-file-preview__frame" data-state="image">
            <img class="cloud-file-preview__image" src={url()} alt={props.t().preview({ name: props.entry.name })} />
          </div>
        )}
      </Match>
    </Switch>
  );
}
