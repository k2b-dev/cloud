import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { PdfDocumentHandle, PdfPageSize } from "./pdf-limits";
import { usePdfMessages } from "./pdf-messages";

export type PdfThumbnailsProps = {
  /** The PDF's bytes; `null` while the host still loads them, which shows placeholders in place. */
  data: Blob | ArrayBuffer | null;
  /** The document's name, for the list's accessible name. */
  title: string;
  /** Shows at most this many pages; a quiet "+n" tile says how many follow. */
  limit?: number;
  /** `sm` is a strip of small tiles beside a name; `md` is a grid of pages to choose from. Defaults to `sm`. */
  size?: "sm" | "md";
  /** Zero-based pages that are chosen. With `onToggle`, every page is a toggle button. */
  selected?: ReadonlySet<number>;
  onToggle?: (index: number) => void;
  /** The document's page count, once it opened. */
  onPages?: (count: number) => void;
  /** The document could not be opened; the tiles say so in place. */
  onError?: (error: unknown) => void;
  class?: string;
};

/** Pixel widths of a drawn tile: twice its CSS width, so pages stay sharp on dense screens. */
const DRAW_WIDTH = { sm: 72, md: 192 } as const;
/** Placeholder tiles before the page count is known. */
const PENDING = 3;

/**
 * Small pictures of a PDF's pages, drawn by pdf.js in the browser: a strip beside a file in a list, or a grid of pages
 * to pick. Every tile keeps the page's proportions from the moment the document opens, so nothing moves while pages
 * are drawn one after another; a tile far below the view waits until it scrolls near.
 */
export function PdfThumbnails(props: PdfThumbnailsProps): JSX.Element {
  const messages = usePdfMessages();
  const size = () => props.size ?? "sm";
  const [pages, setPages] = createSignal<readonly PdfPageSize[] | null>(null);
  const [images, setImages] = createSignal<ReadonlyMap<number, string>>(new Map());
  const [failed, setFailed] = createSignal(false);
  const [visible, setVisible] = createSignal<ReadonlySet<number>>(new Set());
  const [doc, setDoc] = createSignal<{ handle: PdfDocumentHandle; signal: AbortSignal; urls: string[] } | null>(null);

  createEffect(
    on(
      () => props.data,
      (data) => {
        setPages(null);
        setFailed(false);
        setVisible(new Set<number>());
        if (!data) return;
        const opening = new AbortController();
        const urls: string[] = [];
        let opened: PdfDocumentHandle | null = null;
        onCleanup(() => {
          opening.abort();
          setDoc(null);
          for (const url of urls) URL.revokeObjectURL(url);
          setImages(new Map());
          void opened?.close();
        });
        // The loader comes with the first document, so a page without one carries no PDF code.
        void import("./pdf-document").then(({ openPdfDocument }) => openPdfDocument(data, opening.signal)).then(
          (handle) => {
            if (!handle || opening.signal.aborted) return void handle?.close();
            opened = handle;
            setPages(handle.pages);
            setDoc({ handle, signal: opening.signal, urls });
            props.onPages?.(handle.pages.length);
          },
          (error: unknown) => {
            if (opening.signal.aborted) return;
            setFailed(true);
            props.onError?.(error);
          },
        );
      },
    ),
  );

  // One page at a time, in order, only once its tile is near the view.
  let drawing = false;
  const drawNext = async () => {
    const current = doc();
    if (drawing || !current || current.signal.aborted) return;
    const next = [...visible()].sort((a, b) => a - b).find((index) => !images().has(index));
    if (next === undefined) return;
    drawing = true;
    try {
      const image = await current.handle.draw(next, DRAW_WIDTH[size()], current.signal);
      if (!image || current.signal.aborted) return;
      current.urls.push(image.url);
      setImages((all) => new Map(all).set(next, image.url));
    } catch {
      // A page that cannot be drawn keeps its blank tile; the others still draw.
      if (!current.signal.aborted) setImages((all) => new Map(all).set(next, ""));
    } finally {
      drawing = false;
    }
    void drawNext();
  };
  createEffect(on([visible, doc], () => void drawNext()));

  const shown = () => {
    const all = pages();
    if (!all) return [];
    return all.slice(0, props.limit ?? all.length).map((page, index) => ({ page, index }));
  };
  const rest = () => Math.max(0, (pages()?.length ?? 0) - (props.limit ?? Number.POSITIVE_INFINITY));
  const observe = (element: HTMLElement, index: number) => {
    if (typeof IntersectionObserver === "undefined") return setVisible((all) => new Set(all).add(index));
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setVisible((all) => new Set(all).add(index));
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };
  const tile = (page: PdfPageSize, index: number) => {
    const image = () => images().get(index);
    const label = () => messages().pdfThumbnailPage({ number: index + 1 });
    const content = (
      <>
        <span class="k2b-pdf-thumbnails__page" style={{ "aspect-ratio": `${page.width} / ${page.height}` }}>
          <Show when={image()}>{(url) => <img src={url()} alt="" draggable={false} />}</Show>
        </span>
        <Show when={size() === "md"}>
          <span class="k2b-pdf-thumbnails__label">{label()}</span>
        </Show>
      </>
    );
    return (
      <li ref={(element) => observe(element, index)} data-drawn={image() !== undefined ? "" : undefined}>
        <Show when={props.onToggle} fallback={<span title={label()}>{content}</span>}>
          {(toggle) => (
            <button
              type="button"
              class="k2b-pdf-thumbnails__toggle"
              aria-pressed={props.selected?.has(index) ?? false}
              aria-label={label()}
              onClick={() => toggle()(index)}
            >
              {content}
              <span class="k2b-pdf-thumbnails__check" aria-hidden="true">
                <i class="ti ti-check" />
              </span>
            </button>
          )}
        </Show>
      </li>
    );
  };

  return (
    <ul class={`k2b-pdf-thumbnails ${props.class ?? ""}`} data-size={size()} data-failed={failed() ? "" : undefined} aria-label={props.title}>
      <Show
        when={pages()}
        fallback={
          <Show
            when={!failed()}
            fallback={
              <li class="k2b-pdf-thumbnails__failed" role="status">
                {messages().pdfThumbnailsFailed}
              </li>
            }
          >
            <For each={Array.from({ length: Math.min(PENDING, props.limit ?? PENDING) })}>
              {() => (
                <li aria-hidden="true">
                  <span class="k2b-pdf-thumbnails__page k2b-skeleton" />
                </li>
              )}
            </For>
          </Show>
        }
      >
        <For each={shown()}>{(item) => tile(item.page, item.index)}</For>
        <Show when={rest() > 0}>
          <li class="k2b-pdf-thumbnails__more">
            <span aria-hidden="true">+{rest()}</span>
            <span class="k2b-sr-only">{messages().pdfThumbnailMore({ count: rest() })}</span>
          </li>
        </Show>
      </Show>
    </ul>
  );
}

export default PdfThumbnails;
