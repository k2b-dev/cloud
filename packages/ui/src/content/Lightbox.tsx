import {
  type Accessor,
  createEffect,
  createSignal,
  For,
  type JSX,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Button, ButtonLink, IconButton, IconButtonLink } from "../actions/Button";
import { Toolbar } from "../actions/Toolbar";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { showTruncatedTitle } from "../internal/truncated-title";
import { createDelayedLoading } from "../surfaces/Skeleton";
import { FileTypeIcon } from "./FileTypeIcon";
import type { FileViewContent } from "./FileView";
import { type FileViewFile, getFileViewPreviewKind } from "./file-view-preview";
import { useLightboxMessages } from "./lightbox-messages";
import { ThumbnailStrip } from "./ThumbnailStrip";

/*
 * The renderers load when a file needs them, so a page that offers the Lightbox carries only its frame: a gallery of
 * pictures never loads the document, PDF and video code, and an app's first script stays within its budget.
 */
const renderers = () => import("./lightbox-renderers");
const FileView = lazy(() => renderers().then((module) => ({ default: module.FileView })));
const PdfViewer = lazy(() => renderers().then((module) => ({ default: module.PdfViewer })));
const VideoPlayer = lazy(() => renderers().then((module) => ({ default: module.VideoPlayer })));

/** One more command for the shown file, in the action pill before Download: a short label, its icon, and what it does. */
export type LightboxAction = { label: string; icon: string; onClick: () => void };

/**
 * One file the Lightbox can show. Give what the file has: `src` for an image, video, audio file or PDF the browser
 * reads from an address; `load` for text, Markdown, code or PDF bytes; `preview` for a document that only exists as
 * a preview PDF, such as an Office file. `file` names the type when the name alone does not.
 */
export type LightboxItem = {
  /** The name in the pill at the top and in the dialog's accessible name. It never wraps. */
  name: string;
  /** Quiet facts after the name, such as "PDF · 5.1 MB". */
  meta?: string;
  /** Path, media type and size; they choose the renderer as in `FileView`. Defaults to the name. */
  file?: FileViewFile;
  /**
   * An address on this site the browser reads directly: an image, video, audio file, or PDF. A function resolves it
   * when the file is shown, such as a short-lived signed address; "Try again" and a video that runs past its address
   * ask it for a fresh one. Every loader receives a signal that aborts when the person moves on or closes.
   */
  src?: string | ((signal: AbortSignal) => Promise<string>);
  /** Loads text, Markdown, code, or a PDF's bytes. */
  load?: (signal: AbortSignal) => Promise<FileViewContent>;
  /** Loads a preview PDF, such as one converted from an Office file. A rejection shows "Preview not possible". */
  preview?: (signal: AbortSignal) => Promise<Blob>;
  /** A small image for the film strip; without it the strip shows the file's type icon. */
  thumbnail?: string;
  /** Adds Download to the action pill. */
  downloadUrl?: string;
  /** Adds Download for a file the app hands out itself, such as through a short-lived lease. */
  onDownload?: () => void;
  /** Adds the blue Open pill at the front, for an app that can open the file. The caller chooses where it leads. */
  open?: { label?: string; onOpen: () => void };
  /** More commands for this file, before Download. */
  actions?: readonly LightboxAction[];
};

export type LightboxProps = {
  items: readonly LightboxItem[];
  /** The shown item; the caller owns it, so it can follow a selection behind the Lightbox. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** The caller's own control in the action pill after Open, such as "Select" in a file chooser. */
  actions?: (item: LightboxItem) => JSX.Element;
};

type Kind = "image" | "pdf" | "office" | "video" | "audio" | "text" | "none";
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const SWIPE = 60;
const PULL_CLOSE = 110;
/** Seconds the arrows seek in a video or audio file, as `VideoPlayer`'s own keys do. */
const MEDIA_SEEK = 5;
const SPREADSHEET = /\.(xlsx?|ods|csv)$/i;

const kindOf = (item: LightboxItem): Kind => {
  if (item.preview) return "office";
  const kind = getFileViewPreviewKind(item.file ?? { path: item.name });
  if (kind === "image" || kind === "video" || kind === "audio") return item.src ? kind : "none";
  if (kind === "pdf") return item.src || item.load ? "pdf" : "none";
  if (kind && item.load) return "text";
  return "none";
};
const zoomable = (kind: Kind) => kind === "image" || kind === "pdf" || kind === "office" || kind === "text";
/** Keys inside these keep their own meaning. */
const interactive = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest("button, a[href], input, textarea, select, video, audio, [contenteditable=''], [contenteditable=true]"));
/** A focused video or audio file keeps its keys: the arrows seek there instead of stepping to the next file. */
const media = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("video, audio"));
const bytes = (content: FileViewContent) =>
  content.encoding === "base64"
    ? new Blob([Uint8Array.from(atob(content.content), (character) => character.charCodeAt(0))], { type: "application/pdf" })
    : new Blob([content.content], { type: "application/pdf" });

/**
 * The one large view of a file anywhere in Cloud: an image, PDF, video, audio file, text, Markdown, code, or a document
 * shown through its preview PDF, and for anything else its icon, facts and Download. It loads the file itself and
 * shows every state: a placeholder after a short wait, a failure with "Try again", and "Preview not possible".
 *
 * The name sits in a pill at the top left; Open (when the caller gives a target), the caller's commands, Download
 * and Close in a pill at the top right. Large round buttons at the screen edges step between files, as do ← and →
 * and the film strip from two files on; there is no "2 / 8" counter. The only pill at the bottom holds zoom and the
 * page. Escape, Close, a press beside the file or a swipe down close it, and focus returns to the opener. On a phone
 * it fills the screen and a swipe steps between files.
 */
export default function Lightbox(props: LightboxProps): JSX.Element {
  const t = useLightboxMessages();
  const [zoom, setZoom] = createSignal(1);
  const [pages, setPages] = createSignal(0);
  const [page, setPage] = createSignal(0);
  const [title, setTitle] = createSignal<string | null>(null);
  const [pull, setPull] = createSignal(0);
  let dialog!: HTMLDialogElement;
  let stage!: HTMLDivElement;
  let opener: HTMLElement | null = null;
  let openerRing = true;

  const index = () => Math.max(0, Math.min(props.index, props.items.length - 1));
  const item = () => props.items[index()];
  const kind = () => (item() ? kindOf(item()!) : "none");
  /** The shown video or audio element, once the file plays on the stage. */
  const playing = () =>
    kind() === "video" || kind() === "audio" ? (stage?.querySelector<HTMLMediaElement>("video, audio") ?? null) : null;
  createEffect(
    on(item, () => {
      setZoom(1);
      setPages(0);
      setPage(0);
      setTitle(null);
    }),
  );

  const step = (direction: 1 | -1) => {
    const next = index() + direction;
    if (next >= 0 && next < props.items.length) props.onIndexChange(next);
  };
  const zoomBy = (direction: 1 | -1) => {
    if (!zoomable(kind())) return;
    const value = zoom();
    const next =
      direction > 0
        ? ZOOM_STEPS.find((candidate) => candidate > value + 0.001)
        : [...ZOOM_STEPS].reverse().find((candidate) => candidate < value - 0.001);
    if (next !== undefined) setZoom(next);
  };
  const close = () => {
    if (dialog.open) dialog.close();
    returnFocus(opener, openerRing);
    props.onClose();
  };

  // A key belongs to the Lightbox while focus is inside it, or on the page with no other dialog open above it.
  const ownsKey = (target: EventTarget | null) =>
    target instanceof Node &&
    (dialog.contains(target) ||
      (target === document.body && Array.from(document.querySelectorAll("dialog[open]")).every((open) => open === dialog)));
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !ownsKey(event.target)) return;
    const handled = (() => {
      switch (event.key) {
        case "Escape":
          close();
          return true;
        case " ": {
          if (interactive(event.target)) return false;
          // Space plays and pauses a video or audio file; elsewhere it closes, as it opened the Lightbox in a list.
          const shown = playing();
          if (!shown) {
            close();
            return true;
          }
          if (shown.paused) void shown.play().catch(() => {});
          else shown.pause();
          return true;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          if (media(event.target)) return false;
          const direction = event.key === "ArrowRight" ? 1 : -1;
          // A video or audio file keeps the arrows wherever the focus is, in every engine: they seek in it, as its own
          // controls do. The edge buttons and the film strip still step to the next file.
          const shown = playing();
          if (shown) {
            const end = Number.isFinite(shown.duration) ? shown.duration : shown.currentTime + MEDIA_SEEK;
            shown.currentTime = Math.min(end, Math.max(0, shown.currentTime + direction * MEDIA_SEEK));
            return true;
          }
          step(direction);
          return true;
        }
        case "+":
        case "=":
          zoomBy(1);
          return true;
        case "-":
          zoomBy(-1);
          return true;
        case "0":
          setZoom(1);
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  // Touch: a sideways swipe steps, a pull down closes. A zoomed picture keeps its own drag.
  let touch: { x: number; y: number } | null = null;
  const touchStart = (event: TouchEvent) => {
    const first = event.touches.length === 1 ? event.touches[0] : undefined;
    touch = first && zoom() === 1 ? { x: first.clientX, y: first.clientY } : null;
  };
  const touchMove = (event: TouchEvent) => {
    const first = event.touches[0];
    if (!touch || !first) return;
    const dy = first.clientY - touch.y;
    setPull(dy > 0 && dy > Math.abs(first.clientX - touch.x) && stage.scrollTop <= 0 ? dy : 0);
  };
  const touchEnd = (event: TouchEvent) => {
    const last = event.changedTouches[0];
    const start = touch;
    touch = null;
    const pulled = pull();
    setPull(0);
    if (!start || !last) return;
    if (pulled > PULL_CLOSE) return close();
    const dx = last.clientX - start.x;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(last.clientY - start.y)) step(dx < 0 ? 1 : -1);
  };
  // A press on the stage beside the file closes, like a press beside a dialog.
  const stagePress = (event: MouseEvent) => {
    if (event.target === stage || event.target === dialog) close();
  };

  // Registration and teardown both live in onMount: onCleanup also runs when an SSR render is disposed.
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerRing = ringOnReturn(opener);
    opener?.blur();
    dialog.showModal();
    // The file has the focus, not the first command: the keys step and zoom at once, and no ring lands on Open.
    stage.focus({ preventScroll: true });
    document.addEventListener("keydown", keys);
    onCleanup(() => document.removeEventListener("keydown", keys));
  });

  const shownName = () => title() ?? item()?.name ?? "";
  const meta = () => {
    const current = item();
    if (!current) return "";
    const facts = title() ? [current.name, current.meta] : [current.meta];
    if (kind() === "office") facts.push(t().viewOnly);
    return facts.filter(Boolean).join(" · ");
  };
  const pageLabel = () =>
    SPREADSHEET.test(item()?.name ?? "")
      ? t().sheet({ number: page() + 1, total: pages() })
      : t().page({ number: page() + 1, total: pages() });

  return (
    <dialog
      ref={dialog}
      class="k2b-lightbox"
      aria-label={shownName()}
      data-kind={kind()}
      style={pull() ? { "--k2b-lightbox-pull": String(Math.min(1, pull() / (PULL_CLOSE * 2))) } : undefined}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={stagePress}
      onTouchStart={touchStart}
      onTouchMove={touchMove}
      onTouchEnd={touchEnd}
    >
      <div class="k2b-lightbox__main">
        <div ref={stage} class="k2b-lightbox__stage" tabIndex={-1} data-zoomed={zoom() !== 1 ? "" : undefined}>
          {/* Keyed by position and item: each file mounts its own stage and starts its own loading. */}
          <Show keyed when={item()}>
            {(shown) => (
              <LightboxStage item={shown} kind={untrack(kind)} zoom={zoom} onPages={setPages} onPage={setPage} onTitle={setTitle} />
            )}
          </Show>
        </div>
        <Show when={props.items.length > 1}>
          <button
            type="button"
            class="k2b-lightbox__edge k2b-overlay-surface"
            data-direction="previous"
            aria-label={t().previous}
            title={`${t().previous} (←)`}
            style={{ visibility: index() > 0 ? "visible" : "hidden" }}
            onClick={() => step(-1)}
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="k2b-lightbox__edge k2b-overlay-surface"
            data-direction="next"
            aria-label={t().next}
            title={`${t().next} (→)`}
            style={{ visibility: index() < props.items.length - 1 ? "visible" : "hidden" }}
            onClick={() => step(1)}
          >
            <i class="ti ti-chevron-right" aria-hidden="true" />
          </button>
        </Show>
      </div>
      <div class="k2b-lightbox__head">
        <p class="k2b-lightbox__name k2b-overlay-surface">
          <b onPointerEnter={showTruncatedTitle}>{shownName()}</b>
          <Show when={meta()}>
            <span>{meta()}</span>
          </Show>
        </p>
        <div class="k2b-lightbox__actions k2b-overlay-surface" role="group" aria-label={t().actions}>
          <Show when={item()?.open}>
            {(open) => (
              <Button size="sm" class="k2b-lightbox__open" onClick={() => open().onOpen()}>
                <i class="ti ti-external-link" aria-hidden="true" />
                {open().label ?? t().open}
              </Button>
            )}
          </Show>
          <Show when={item()}>{(shown) => props.actions?.(shown())}</Show>
          <For each={item()?.actions ?? []}>
            {(action) => (
              <Button size="sm" variant="ghost" class="k2b-lightbox__action" aria-label={action.label} onClick={action.onClick}>
                <i class={action.icon} aria-hidden="true" />
                <span class="k2b-lightbox__action-label">{action.label}</span>
              </Button>
            )}
          </For>
          <Show when={item()?.downloadUrl}>
            {(href) => (
              <IconButtonLink variant="ghost" label={t().download} href={href()} download="" navigation="document">
                <i class="ti ti-download" aria-hidden="true" />
              </IconButtonLink>
            )}
          </Show>
          <Show when={!item()?.downloadUrl && item()?.onDownload}>
            {(download) => (
              <IconButton variant="ghost" label={t().download} onClick={() => download()()}>
                <i class="ti ti-download" aria-hidden="true" />
              </IconButton>
            )}
          </Show>
          <span class="k2b-lightbox__separator" aria-hidden="true" />
          <IconButton variant="ghost" label={t().close} tooltip={t().closeHint} onClick={close}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      {/* The pill keeps its place for every file, so nothing moves; files without zoom or pages leave it hidden. */}
      <div class="k2b-lightbox__bar" style={{ visibility: zoomable(kind()) || pages() > 1 ? "visible" : "hidden" }}>
        <Toolbar label={t().view} class="k2b-lightbox__tools k2b-overlay-surface">
          <Toolbar.Action
            label={t().zoomOut}
            icon="ti ti-minus"
            disabled={!zoomable(kind()) || zoom() <= ZOOM_STEPS[0]}
            onClick={() => zoomBy(-1)}
          />
          <Toolbar.Label class="k2b-lightbox__percent">
            <span aria-live="polite">{zoomable(kind()) ? t().percent({ value: Math.round(zoom() * 100) }) : ""}</span>
          </Toolbar.Label>
          <Toolbar.Action
            label={t().zoomIn}
            icon="ti ti-plus"
            disabled={!zoomable(kind()) || zoom() >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
            onClick={() => zoomBy(1)}
          />
          <Show when={pages() > 1}>
            <Toolbar.Separator />
            <Toolbar.Label class="k2b-lightbox__page">{pageLabel()}</Toolbar.Label>
          </Show>
        </Toolbar>
      </div>
      <Show when={props.items.length > 1}>
        <ThumbnailStrip
          class="k2b-lightbox__strip"
          label={t().files}
          items={props.items.map((entry, position) => ({
            id: String(position),
            name: entry.name,
            thumbnail: entry.thumbnail ?? (() => <FileTypeIcon name={entry.file?.path ?? entry.name} />),
          }))}
          currentItem={String(index())}
          onSelectItem={(id) => props.onIndexChange(Number(id))}
        />
      </Show>
    </dialog>
  );
}

/** One file on the stage: it loads, and shows a placeholder after a short wait, a failure with retry, or the file. */
function LightboxStage(props: {
  item: LightboxItem;
  kind: Kind;
  zoom: Accessor<number>;
  onPages: (pages: number) => void;
  onPage: (page: number) => void;
  onTitle: (title: string | null) => void;
}): JSX.Element {
  const t = useLightboxMessages();
  // Each attempt mounts the content anew; "Try again" starts the next one.
  const [attempt, setAttempt] = createSignal(0);
  const [state, setState] = createSignal<"loading" | "ready" | "failed">(props.kind === "none" ? "ready" : "loading");
  const placeholder = createDelayedLoading(() => state() === "loading");
  const [document_, setDocument] = createSignal<Blob | string | null>(null);
  // The address the browser reads; a resolver runs once per attempt, so a retry asks for a fresh signed address.
  const [source, setSource] = createSignal<string | null>(null);
  const failed = () => setState("failed");
  const ready = () => setState("ready");
  const downloadable = () => Boolean(props.item.downloadUrl || props.item.onDownload);
  const download = (variant: "primary" | "secondary") => (
    <Show
      when={props.item.downloadUrl}
      fallback={
        <Show when={props.item.onDownload}>
          {(run) => (
            <Button size="sm" variant={variant} onClick={() => run()()}>
              <i class="ti ti-download" aria-hidden="true" />
              {t().download}
            </Button>
          )}
        </Show>
      }
    >
      {(href) => (
        <ButtonLink size="sm" variant={variant} href={href()} download="" navigation="document">
          <i class="ti ti-download" aria-hidden="true" />
          {t().download}
        </ButtonLink>
      )}
    </Show>
  );

  // Each attempt owns a signal: moving on, closing, or trying again stops what the previous one still loads.
  let loading: AbortController | undefined;
  onCleanup(() => loading?.abort());
  const signal = () => loading?.signal ?? new AbortController().signal;
  const settle =
    <T,>(then: (value: T) => void) =>
    (value: T) => {
      if (!signal().aborted) then(value);
    };
  const fail = () => {
    if (!signal().aborted) failed();
  };
  const resolveSource = (): Promise<string | null> => {
    const src = props.item.src;
    return typeof src === "function" ? src(signal()) : Promise.resolve(src ?? null);
  };

  // Addresses, PDFs from bytes and preview PDFs load here; the viewers then draw them.
  createEffect(
    on(attempt, () => {
      loading?.abort();
      loading = new AbortController();
      setState(props.kind === "none" ? "ready" : "loading");
      setDocument(null);
      setSource(null);
      if (props.kind === "office" && props.item.preview) props.item.preview(signal()).then(settle(setDocument), fail);
      else if (props.kind === "pdf" && !props.item.src)
        props.item.load?.(signal()).then(
          settle((content: FileViewContent) => setDocument(bytes(content))),
          fail,
        );
      else if (props.item.src)
        resolveSource().then(
          settle((value: string | null) => {
            if (!value) return failed();
            setSource(value);
            if (props.kind === "pdf") setDocument(value);
            // The video player shows its own loading; the frame is ready as soon as it has an address.
            if (props.kind === "video") ready();
          }),
          fail,
        );
    }),
  );

  return (
    <div class="k2b-lightbox__content" data-state={state()}>
      <Show when={state() === "failed"}>
        <div class="k2b-lightbox__notice" role="alert">
          <i class="ti ti-file-alert k2b-lightbox__notice-icon" aria-hidden="true" />
          <b>{props.kind === "office" ? t().notPossible : t().failed}</b>
          <span>{props.kind === "office" ? t().notPossibleHint : t().failedHint}</span>
          <div class="k2b-lightbox__notice-actions">
            <Show when={props.kind === "office" && props.item.open}>
              {(open) => (
                <Button size="sm" onClick={() => open().onOpen()}>
                  {open().label ?? t().open}
                </Button>
              )}
            </Show>
            <Show when={props.kind !== "office"}>
              <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().retry}
              </Button>
            </Show>
            {download("secondary")}
          </div>
        </div>
      </Show>
      <Show when={placeholder()}>
        <div class="k2b-lightbox__placeholder k2b-skeleton" data-kind={props.kind} role="status" aria-label={t().loading}>
          <Show when={props.kind === "office"}>
            <span class="k2b-lightbox__converting">{t().converting}</span>
          </Show>
        </div>
      </Show>
      <Show keyed when={state() !== "failed" && attempt() + 1}>
        <Switch>
          <Match when={props.kind === "image" && source()}>
            {(src) => <LightboxImage src={src()} name={props.item.name} zoom={props.zoom} onReady={ready} onError={failed} />}
          </Match>
          <Match when={(props.kind === "pdf" || props.kind === "office") && document_()}>
            {(data) => (
              <PdfViewer
                class="k2b-lightbox__pdf"
                data={data()}
                title={props.item.name}
                zoom={false}
                fit="page"
                scale={props.zoom()}
                onReady={(drawn) => {
                  props.onPages(drawn.pages);
                  ready();
                }}
                onPage={props.onPage}
                onError={failed}
              />
            )}
          </Match>
          <Match when={props.kind === "video" && source()}>
            {(src) => (
              // The shared player renews a short-lived address and goes on at the same time; it has the keys at once.
              <div
                class="k2b-lightbox__video"
                ref={(element) => requestAnimationFrame(() => element.querySelector("video")?.focus({ preventScroll: true }))}
              >
                <VideoPlayer
                  src={src()}
                  label={props.item.name}
                  renew={typeof props.item.src === "function" ? () => resolveSource().then((value) => value ?? src()) : undefined}
                  fallbackAction={download("secondary")}
                />
              </div>
            )}
          </Match>
          <Match when={props.kind === "audio" && source()}>
            {(src) => (
              <div class="k2b-lightbox__audio">
                <FileTypeIcon name={props.item.file?.path ?? props.item.name} size="lg" />
                <audio src={src()} controls preload="metadata" onLoadedMetadata={ready} onError={failed} />
              </div>
            )}
          </Match>
          <Match when={props.kind === "text"}>
            <article class="k2b-lightbox__text" style={{ "--k2b-lightbox-text-scale": String(props.zoom()) }}>
              <FileView
                variant="plain"
                file={props.item.file ?? { path: props.item.name }}
                load={() =>
                  props.item.load!(signal()).then(
                    (content) => {
                      ready();
                      return content;
                    },
                    (error: unknown) => {
                      failed();
                      throw error;
                    },
                  )
                }
                onDocumentTitle={props.onTitle}
              />
            </article>
          </Match>
          <Match when={props.kind === "none"}>
            <div class="k2b-lightbox__notice">
              <FileTypeIcon name={props.item.file?.path ?? props.item.name} size="lg" />
              <b>{t().noPreview}</b>
              <span>{downloadable() ? t().noPreviewHint : props.item.meta}</span>
              <Show when={downloadable()}>
                <div class="k2b-lightbox__notice-actions">{download("primary")}</div>
              </Show>
            </div>
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

/** A picture fitted to the stage; zoomed in, it follows the pointer while dragged. */
function LightboxImage(props: { src: string; name: string; zoom: Accessor<number>; onReady: () => void; onError: () => void }) {
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  createEffect(
    on(props.zoom, (value) => {
      if (value <= 1) setPan({ x: 0, y: 0 });
    }),
  );
  let start: { x: number; y: number; panX: number; panY: number } | null = null;
  return (
    <img
      class="k2b-lightbox__image"
      src={props.src}
      alt={props.name}
      draggable={false}
      data-dragging={dragging() ? "" : undefined}
      style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${props.zoom()})` }}
      onLoad={props.onReady}
      onError={props.onError}
      onPointerDown={(event) => {
        if (props.zoom() <= 1) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start = { x: event.clientX, y: event.clientY, panX: pan().x, panY: pan().y };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!start) return;
        setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
      }}
      onPointerUp={() => {
        start = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        start = null;
        setDragging(false);
      }}
    />
  );
}
