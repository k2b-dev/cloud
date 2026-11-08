import { batch, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { Toolbar } from "../actions/Toolbar";
import { openPdfDocument, type PdfDocumentHandle, type PdfPageImage, type PdfPageSize, pageImageWidth } from "./pdf-document";
import { usePdfMessages } from "./pdf-messages";

export type PdfViewerProps = {
  /** The PDF itself. A new value opens that document. */
  data: Blob | ArrayBuffer;
  /** The document's name, for the scroll area and the page images. */
  title: string;
  /** Without the zoom bar, always fit to the width. Defaults to `true`. */
  zoom?: boolean;
  /** Shows only this page (zero-based) instead of all pages one below the other. */
  page?: number;
  /** The first visible page is drawn; a host can drop its loading state. */
  onReady?: () => void;
  /** The document could not be opened, or a page could not be drawn and has no image yet. */
  onError?: (error: unknown) => void;
  class?: string;
};

/** CSS pixels per PDF point at 100 %: 96 dpi on screen, 72 points per inch. */
const POINT = 96 / 72;
/** Steps for − and + in percent; Ctrl or ⌘ with the wheel and two fingers zoom freely between the first and the last. */
export const PDF_ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300] as const;
const SMALLEST = PDF_ZOOM_STEPS[0];
const LARGEST = PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1] ?? 300;
/** Horizontal padding of the page stack, both sides together. */
const INSET = 24;
/** Pages within this distance of the view draw; farther ones keep only their box. */
const NEAR_MARGIN = "150% 0px";
/** At most this many drawn pages stay in memory; the ones out of view are released first. */
const KEPT_IMAGES = 24;

/** The next zoom step above or below `percent`; at either end it stays there. */
export const nextPdfZoomStep = (percent: number, direction: 1 | -1): number =>
  direction === 1
    ? (PDF_ZOOM_STEPS.find((step) => step > percent + 0.5) ?? LARGEST)
    : ([...PDF_ZOOM_STEPS].reverse().find((step) => step < percent - 0.5) ?? SMALLEST);

/**
 * The page width most pages share, at a tie the first page's. "Width" fits every page to the area, so a landscape page
 * among portrait ones never scrolls sideways; percentages and fixed zoom follow this common width.
 */
export const commonPageWidth = (pages: readonly PdfPageSize[]): number => {
  const counts = new Map<number, number>();
  for (const page of pages) counts.set(Math.round(page.width), (counts.get(Math.round(page.width)) ?? 0) + 1);
  let best = Math.round(pages[0]?.width ?? 1);
  let most = 0;
  for (const [width, count] of counts)
    if (count > most) {
      best = width;
      most = count;
    }
  return Math.max(1, best);
};

/**
 * A PDF drawn by pdf.js in every browser: pages as images in one scroll area, an invisible text layer over each page
 * to select, copy, and find text, and a small zoom bar. Only pages near the view are drawn and carry text; the others
 * keep their size, so the scroll bar is right from the start. Printing and forms stay with the browser's own viewer.
 */
export default function PdfViewer(props: PdfViewerProps): JSX.Element {
  const messages = usePdfMessages();
  const [doc, setDoc] = createSignal<PdfDocumentHandle | null>(null);
  const pages = (): readonly PdfPageSize[] => doc()?.pages ?? [];
  const shown = () =>
    props.page === undefined ? pages().map((_, index) => index) : [props.page].filter((index) => index < pages().length);
  const [images, setImages] = createSignal<ReadonlyMap<number, PdfPageImage>>(new Map());
  const [near, setNear] = createSignal<ReadonlySet<number>>(new Set());
  const [fitWidth, setFitWidth] = createSignal(true);
  const [fixed, setFixed] = createSignal(POINT);
  const [inner, setInner] = createSignal(0);
  const [current, setCurrent] = createSignal(0);
  const [ready, setReady] = createSignal(false);
  let area: HTMLDivElement | undefined;
  let drawRun: AbortController | undefined;
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;

  const releaseAll = () => {
    for (const image of images().values()) URL.revokeObjectURL(image.url);
    setImages(new Map());
  };

  // Opening: a new `data` opens a new document and closes the previous one.
  createEffect(
    on(
      () => props.data,
      (data) => {
        const opening = new AbortController();
        let opened: PdfDocumentHandle | null = null;
        onCleanup(() => {
          opening.abort();
          drawRun?.abort();
          releaseAll();
          void opened?.close();
        });
        setReady(false);
        void openPdfDocument(data, opening.signal).then(
          (handle) => {
            if (!handle || opening.signal.aborted) return void handle?.close();
            opened = handle;
            // A document without pages has nothing to draw; the host shows its fallback instead of waiting forever.
            if (handle.pages.length === 0) return void props.onError?.(new Error("The PDF has no pages"));
            setDoc(handle);
          },
          (error: unknown) => {
            if (!opening.signal.aborted) props.onError?.(error);
          },
        );
      },
    ),
  );
  onCleanup(() => {
    gone = true;
    clearTimeout(drawTimer);
  });

  const commonWidth = createMemo(() => commonPageWidth(pages()));
  const areaWidth = () => Math.max(120, inner());
  /** CSS pixels per point of the common page width; percent, steps, and fixed zoom follow from it. */
  const factor = () => (fitWidth() ? areaWidth() / commonWidth() : fixed());
  const percent = () => Math.round((factor() / POINT) * 100);
  const pageWidth = (page: PdfPageSize) => Math.max(1, Math.floor(fitWidth() ? areaWidth() : page.width * fixed()));

  /**
   * Draws each near page whose image is too small (blurred) or far too large (memory) for its shown size. A new zoom or
   * scroll aborts and continues. A page that fails keeps its old image; without one, `onError` reports it.
   */
  const redraw = async () => {
    drawRun?.abort();
    const run = new AbortController();
    drawRun = run;
    const handle = doc();
    if (!handle) return;
    const order = shown().filter((index) => near().has(index));
    for (const index of order) {
      const page = pages()[index];
      if (!page) continue;
      const target = pageImageWidth(pageWidth(page), window.devicePixelRatio, page.height / page.width);
      const existing = images().get(index);
      if (existing && target <= existing.width * 1.15 && target >= existing.width * 0.5) continue;
      const image = await handle.draw(index, target, run.signal).catch(() => "failed" as const);
      if (run.signal.aborted || gone || doc() !== handle) {
        if (image && image !== "failed") URL.revokeObjectURL(image.url);
        return;
      }
      if (image === "failed" || !image) {
        if (existing) continue;
        props.onError?.(new Error(`Page ${index + 1} could not be drawn`));
        return;
      }
      setImages((previous) => {
        const next = new Map(previous);
        next.set(index, image);
        // Keep memory bounded: release drawn pages out of view, oldest first, past the limit.
        for (const key of next.keys()) {
          if (next.size <= KEPT_IMAGES) break;
          if (near().has(key)) continue;
          const released = next.get(key);
          if (released) URL.revokeObjectURL(released.url);
          next.delete(key);
        }
        return next;
      });
      if (existing) URL.revokeObjectURL(existing.url);
      if (!ready()) {
        setReady(true);
        props.onReady?.();
      }
    }
  };
  const scheduleRedraw = (delay: number) => {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(() => void redraw(), delay);
  };
  createEffect(on(factor, () => scheduleRedraw(200), { defer: true }));
  createEffect(on(near, () => scheduleRedraw(0), { defer: true }));
  createEffect(
    on(
      () => props.page,
      () => {
        if (area) area.scrollTop = 0;
        scheduleRedraw(0);
      },
      { defer: true },
    ),
  );

  /**
   * Zooms to `target` (CSS pixels per point) around a point of the area (pointer, between the fingers, else the
   * centre) that stays where it is. The point counts relative to the page under it, because padding, gaps, and the
   * centring of narrow pages do not grow with the zoom.
   */
  const zoomTo = (target: number, clientX?: number, clientY?: number) => {
    if (props.zoom === false || !area) return;
    const before = factor();
    const next = (Math.min(LARGEST, Math.max(SMALLEST, (target / POINT) * 100)) / 100) * POINT;
    if (Math.abs(next - before) < 1e-4) return;
    const box = area.getBoundingClientRect();
    const x = clientX ?? box.left + area.clientWidth / 2;
    const y = clientY ?? box.top + area.clientHeight / 2;
    const boxes = [...area.querySelectorAll<HTMLElement>("[data-pdf-page]")];
    const distance = (page: HTMLElement) => {
      const rect = page.getBoundingClientRect();
      return y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    };
    const anchor = boxes.reduce<HTMLElement | undefined>(
      (best, page) => (!best || distance(page) < distance(best) ? page : best),
      undefined,
    );
    const anchorBefore = anchor?.getBoundingClientRect();
    const relativeX = anchorBefore ? (x - anchorBefore.left) / anchorBefore.width : 0;
    const relativeY = anchorBefore ? (y - anchorBefore.top) / anchorBefore.height : 0;
    batch(() => {
      setFitWidth(false);
      setFixed(next);
    });
    if (!anchor) return;
    const anchorAfter = anchor.getBoundingClientRect();
    area.scrollLeft += anchorAfter.left + relativeX * anchorAfter.width - x;
    area.scrollTop += anchorAfter.top + relativeY * anchorAfter.height - y;
  };
  const step = (direction: 1 | -1) => zoomTo((nextPdfZoomStep(percent(), direction) / 100) * POINT);
  const fit = () => {
    if (!area || fitWidth()) return;
    const before = factor();
    const top = area.scrollTop;
    setFitWidth(true);
    area.scrollLeft = 0;
    area.scrollTop = (top * factor()) / before;
  };

  onMount(() => {
    if (!area) return;
    const scroller = area;
    setInner(scroller.clientWidth - INSET);
    const resize = new ResizeObserver(() => setInner(scroller.clientWidth - INSET));
    resize.observe(scroller);
    // Pages near the view draw and carry their text; the observer follows every page box as it appears. Without an
    // IntersectionObserver every page counts as near, as MapView does.
    const nearPages =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              setNear((previous) => {
                const next = new Set(previous);
                for (const entry of entries) {
                  const index = Number(entry.target.getAttribute("data-pdf-page"));
                  if (entry.isIntersecting) next.add(index);
                  else next.delete(index);
                }
                return next;
              });
            },
            { root: scroller, rootMargin: NEAR_MARGIN },
          );
    if (!nearPages) createEffect(() => setNear(new Set(shown())));
    const watched = new MutationObserver(() => {
      for (const page of scroller.querySelectorAll<HTMLElement>("[data-pdf-page]:not([data-observed])")) {
        page.dataset.observed = "";
        nearPages?.observe(page);
      }
    });
    watched.observe(scroller, { childList: true, subtree: true });
    // The page in the middle of the view is the current one.
    let frame = 0;
    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
        for (const page of scroller.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
          const rect = page.getBoundingClientRect();
          if (rect.bottom >= middle) {
            setCurrent(Number(page.dataset.pdfPage));
            break;
          }
        }
      });
    };
    // Ctrl or ⌘ with the wheel; a trackpad pinch sends the same with Ctrl. Without a key the wheel scrolls as always.
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const delta = Math.max(-120, Math.min(120, event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY));
      zoomTo(factor() * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    };
    // Two fingers on touch; `touch-action: pan-x pan-y` leaves scrolling to the browser but keeps page zoom out.
    let pinch: { distance: number; factor: number } | null = null;
    const spread = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) pinch = { distance: spread(event.touches) || 1, factor: factor() };
    };
    const touchMove = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!pinch || !a || !b) return;
      event.preventDefault();
      zoomTo((pinch.factor * spread(event.touches)) / pinch.distance, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    };
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    // Safari on a Mac reports a trackpad pinch as its own gesture (`scale`), not as a wheel.
    let gestureStart = 0;
    const gestureBegin = (event: Event) => {
      if (pinch) return;
      event.preventDefault();
      gestureStart = factor();
    };
    const gestureChange = (event: Event) => {
      const scale: unknown = Reflect.get(event, "scale");
      if (pinch || !gestureStart || typeof scale !== "number") return;
      event.preventDefault();
      const x: unknown = Reflect.get(event, "clientX");
      const y: unknown = Reflect.get(event, "clientY");
      zoomTo(gestureStart * scale, typeof x === "number" ? x : undefined, typeof y === "number" ? y : undefined);
    };
    const gestureEnd = () => {
      gestureStart = 0;
    };
    // pdf.js keeps a selection from jumping across gaps only while it knows a drag is selecting.
    const selectEnd = () => {
      for (const layer of scroller.querySelectorAll(".k2b-pdf-viewer__text.selecting")) layer.classList.remove("selecting");
    };
    scroller.addEventListener("scroll", track, { passive: true });
    scroller.addEventListener("wheel", wheel, { passive: false });
    scroller.addEventListener("touchstart", touchStart, { passive: true });
    scroller.addEventListener("touchmove", touchMove, { passive: false });
    scroller.addEventListener("touchend", touchEnd);
    scroller.addEventListener("touchcancel", touchEnd);
    scroller.addEventListener("gesturestart", gestureBegin);
    scroller.addEventListener("gesturechange", gestureChange);
    scroller.addEventListener("gestureend", gestureEnd);
    window.addEventListener("pointerup", selectEnd);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      nearPages?.disconnect();
      watched.disconnect();
      scroller.removeEventListener("scroll", track);
      scroller.removeEventListener("wheel", wheel);
      scroller.removeEventListener("touchstart", touchStart);
      scroller.removeEventListener("touchmove", touchMove);
      scroller.removeEventListener("touchend", touchEnd);
      scroller.removeEventListener("touchcancel", touchEnd);
      scroller.removeEventListener("gesturestart", gestureBegin);
      scroller.removeEventListener("gesturechange", gestureChange);
      scroller.removeEventListener("gestureend", gestureEnd);
      window.removeEventListener("pointerup", selectEnd);
    });
  });

  return (
    <div class={`k2b-pdf-viewer ${props.class ?? ""}`} data-drawn={ready() ? "" : undefined}>
      {/* One scroll area: fitted to the width it scrolls only down, zoomed the same area also scrolls sideways. */}
      <div
        ref={area}
        class="k2b-pdf-viewer__pages"
        data-fit={fitWidth() ? "" : undefined}
        data-zoom={percent()}
        tabIndex={0}
        role="document"
        aria-label={props.title}
      >
        <div class="k2b-pdf-viewer__stack">
          <For each={shown()}>
            {(index) => {
              const page = () => pages()[index] ?? { width: 1, height: 1 };
              const width = () => pageWidth(page());
              const image = () => images().get(index);
              return (
                <div
                  class="k2b-pdf-viewer__page"
                  data-pdf-page={index}
                  style={{
                    width: `${width()}px`,
                    "aspect-ratio": `${page().width} / ${page().height}`,
                    "--total-scale-factor": String(width() / page().width),
                  }}
                >
                  <Show when={image()}>
                    {(drawn) => (
                      <img
                        src={drawn().url}
                        width={drawn().width}
                        height={drawn().height}
                        draggable={false}
                        alt={`${props.title}: ${messages().pdfPage({ number: index + 1, total: pages().length })}`}
                      />
                    )}
                  </Show>
                  <Show when={near().has(index) && doc()} keyed>
                    {(handle) => <PdfTextLayer document={handle} index={index} />}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <Show when={props.zoom !== false && doc()}>
        <div class="k2b-pdf-viewer__bar">
          <Toolbar label={messages().pdfZoom}>
            <Show when={props.page === undefined && pages().length > 1}>
              <Toolbar.Label class="k2b-pdf-viewer__page-number">
                <span class="k2b-sr-only">{messages().pdfPage({ number: current() + 1, total: pages().length })}</span>
                <span aria-hidden="true">{messages().pdfPageShort({ number: current() + 1, total: pages().length })}</span>
              </Toolbar.Label>
              <Toolbar.Separator />
            </Show>
            <Toolbar.Action label={messages().pdfZoomOut} icon="ti ti-minus" disabled={percent() <= SMALLEST} onClick={() => step(-1)} />
            <Toolbar.Label class="k2b-pdf-viewer__percent">
              <span aria-live="polite">{messages().pdfZoomPercent({ value: percent() })}</span>
            </Toolbar.Label>
            <Toolbar.Action label={messages().pdfZoomIn} icon="ti ti-plus" disabled={percent() >= LARGEST} onClick={() => step(1)} />
            <Toolbar.Separator />
            <Button
              variant="ghost"
              type="button"
              aria-pressed={fitWidth()}
              aria-label={messages().pdfFitWidthLabel}
              title={messages().pdfFitWidthLabel}
              onClick={fit}
            >
              <i class="ti ti-arrows-horizontal" aria-hidden="true" /> {messages().pdfFitWidth}
            </Button>
          </Toolbar>
        </div>
      </Show>
    </div>
  );
}

/** One page's text layer; pdf.js builds it once, and zoom changes only `--total-scale-factor` on the page. */
function PdfTextLayer(props: { document: PdfDocumentHandle; index: number }): JSX.Element {
  let layer: HTMLDivElement | undefined;
  onMount(() => {
    if (!layer) return;
    const container = layer;
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    void props.document.textLayer(props.index, container, abort.signal).then(
      () => {
        if (abort.signal.aborted) return;
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.append(end);
      },
      () => undefined,
    );
  });
  return <div ref={layer} class="k2b-pdf-viewer__text" onPointerDown={() => layer?.classList.add("selecting")} />;
}
