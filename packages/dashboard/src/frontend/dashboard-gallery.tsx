import type { DashboardWidgetSize } from "@k2b/cloud/contracts";
import {
  BottomSheet,
  Button,
  bottomSheetOptions,
  dialogCore,
  PanelDialog,
  panelDialogFixedOptions,
  panelDialogWidePanelClass,
  SegmentedControl,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { DashboardCatalogWidget } from "../shared";
import { DashboardWidgetFrame } from "./dashboard-tile";
import { dashboardMessages } from "./messages";
import { type DashboardTileState, loadDashboardWidgets } from "./widget-board";

/** Previews the gallery asks at the same time, the budget Core gives one board. */
export const DASHBOARD_GALLERY_PREVIEW_CONCURRENCY = 8;
/** The phone breakpoint of the board; the gallery opens as a bottom sheet below it. */
export const DASHBOARD_PHONE_QUERY = "(max-width: 47.999rem)";
/** A preview's frame in rem, the size the widget has on a four-column board, scaled down to fit its card. */
const PREVIEW_FRAME_REM: Record<DashboardWidgetSize, [number, number]> = {
  small: [16.25, 10.5],
  medium: [33.5, 10.5],
  large: [33.5, 22],
};

export type DashboardGalleryChoice = { key: string; size: DashboardWidgetSize };

const previewId = (key: string, size: DashboardWidgetSize) => `${key}@${size}`;

/**
 * Asks for previews of the widgets the gallery shows, at most eight at a time and each once per size; `onTile`
 * receives each answer under its key and size.
 */
const createPreviewQueue = (locale: () => string, onTile: (id: string, state: DashboardTileState) => void) => {
  const controller = new AbortController();
  const asked = new Set<string>();
  const queue: DashboardGalleryChoice[] = [];
  let running = 0;
  const pump = () => {
    while (running < DASHBOARD_GALLERY_PREVIEW_CONCURRENCY && queue.length > 0 && !controller.signal.aborted) {
      // One stream asks a widget once, so a batch holds each key at most once.
      const batch: DashboardGalleryChoice[] = [];
      for (let index = 0; index < queue.length && running + batch.length < DASHBOARD_GALLERY_PREVIEW_CONCURRENCY; ) {
        const next = queue[index]!;
        if (batch.some((entry) => entry.key === next.key)) index += 1;
        else batch.push(...queue.splice(index, 1));
      }
      running += batch.length;
      void loadDashboardWidgets({
        widgets: batch,
        signal: controller.signal,
        locale: locale(),
        onTile: (key, state) => {
          running -= 1;
          const size = batch.find((entry) => entry.key === key)!.size;
          onTile(previewId(key, size), state);
          pump();
        },
      });
    }
  };
  return {
    request: (key: string, size: DashboardWidgetSize) => {
      const id = previewId(key, size);
      if (asked.has(id)) return;
      asked.add(id);
      queue.push({ key, size });
      pump();
    },
    stop: () => controller.abort(),
  };
};

/** Scales a preview frame down to its card, so the widget shows the same layout it has on the board. */
const ScaledPreview = (props: { size: DashboardWidgetSize; children: JSX.Element }) => {
  let box: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(1);
  onMount(() => {
    const fit = () => {
      if (!box || !inner || inner.offsetWidth === 0) return;
      setScale(Math.min(1, box.clientWidth / inner.offsetWidth, box.clientHeight / inner.offsetHeight));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(box!);
    observer.observe(inner!);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div ref={box} class="dashboard-gallery-card__preview" aria-hidden="true" inert>
      <div
        ref={inner}
        class="dashboard-gallery-card__scale"
        style={{
          width: `${PREVIEW_FRAME_REM[props.size][0]}rem`,
          height: `${PREVIEW_FRAME_REM[props.size][1]}rem`,
          transform: `translate(-50%, -50%) scale(${scale()})`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
};

const GalleryCard = (props: {
  widget: DashboardCatalogWidget;
  onBoard: boolean;
  preview: (size: DashboardWidgetSize) => DashboardTileState;
  request: (size: DashboardWidgetSize) => void;
  onAdd: (size: DashboardWidgetSize) => void;
}) => {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const [size, setSize] = createSignal(props.widget.defaultSize);
  const [visible, setVisible] = createSignal(false);
  let card: HTMLDivElement | undefined;
  onMount(() => {
    // A preview loads only once its card is on screen.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        props.request(size());
        observer.disconnect();
      }
    });
    observer.observe(card!);
    onCleanup(() => observer.disconnect());
  });
  const choose = (next: DashboardWidgetSize) => {
    setSize(next);
    if (visible()) props.request(next);
  };
  return (
    <div ref={card} class="dashboard-gallery-card" data-key={props.widget.key}>
      <ScaledPreview size={size()}>
        <DashboardWidgetFrame widget={props.widget} state={props.preview(size())} />
      </ScaledPreview>
      <div class="dashboard-gallery-card__meta">
        <b>{props.widget.title}</b>
        <span>{props.widget.description}</span>
      </div>
      <div class="dashboard-gallery-card__actions">
        <Show
          when={props.widget.sizes.length > 1}
          fallback={<span class="dashboard-gallery-card__size">{t()[props.widget.defaultSize]}</span>}
        >
          <SegmentedControl<DashboardWidgetSize>
            size="sm"
            ariaLabel={t().sizeFor({ name: props.widget.title })}
            value={size}
            onValueChange={choose}
            options={props.widget.sizes.map((value) => ({ value, label: t()[value] }))}
          />
        </Show>
        <Show
          when={!props.onBoard}
          fallback={
            <Button size="sm" variant="secondary" disabled>
              <i class="ti ti-check" aria-hidden="true" />
              {t().onBoard}
            </Button>
          }
        >
          <Button size="sm" aria-label={t().addNamed({ name: props.widget.title })} onClick={() => props.onAdd(size())}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().add}
          </Button>
        </Show>
      </div>
    </div>
  );
};

const normalize = (value: string) => value.toLocaleLowerCase().trim();

/**
 * The widget gallery: a search, the widgets suggested for this person that are not on the board yet, then every
 * widget grouped by app, each with a live preview of the person's own data in the size they choose.
 */
export function DashboardGallery(props: {
  catalog: readonly DashboardCatalogWidget[];
  onBoard: ReadonlySet<string>;
  seed: (key: string, size: DashboardWidgetSize) => DashboardTileState | undefined;
  onAdd: (choice: DashboardGalleryChoice) => void;
}) {
  const locale = useLocale();
  const t = () => dashboardMessages.resolve([locale()]).t;
  const [query, setQuery] = createSignal("");
  const [previews, setPreviews] = createSignal<Record<string, DashboardTileState>>({});
  const queue = createPreviewQueue(locale, (id, state) => setPreviews((current) => ({ ...current, [id]: state })));
  onCleanup(() => queue.stop());
  const preview = (key: string, size: DashboardWidgetSize): DashboardTileState =>
    previews()[previewId(key, size)] ?? props.seed(key, size) ?? { status: "loading" };
  const request = (key: string, size: DashboardWidgetSize) => {
    if (props.seed(key, size)?.status !== "ok") queue.request(key, size);
  };

  const matches = createMemo(() => {
    const words = normalize(query());
    return props.catalog.filter((widget) => !words || normalize(`${widget.title} ${widget.description} ${widget.appName}`).includes(words));
  });
  const suggested = createMemo(() =>
    query().trim() ? [] : matches().filter((widget) => widget.suggest && !props.onBoard.has(widget.key)),
  );
  const byApp = createMemo(() => {
    const groups = new Map<string, { appName: string; appIcon: string; widgets: DashboardCatalogWidget[] }>();
    const shown = new Set(suggested().map((widget) => widget.key));
    for (const widget of matches()) {
      if (shown.has(widget.key)) continue;
      const group = groups.get(widget.appId) ?? { appName: widget.appName, appIcon: widget.appIcon, widgets: [] };
      group.widgets.push(widget);
      groups.set(widget.appId, group);
    }
    return [...groups.values()];
  });
  const card = (widget: DashboardCatalogWidget) => (
    <GalleryCard
      widget={widget}
      onBoard={props.onBoard.has(widget.key)}
      preview={(size) => preview(widget.key, size)}
      request={(size) => request(widget.key, size)}
      onAdd={(size) => props.onAdd({ key: widget.key, size })}
    />
  );

  return (
    <div class="dashboard-gallery">
      <div class="dashboard-gallery__search">
        <TextInput
          type="search"
          icon="ti ti-search"
          value={query}
          onValueChange={setQuery}
          placeholder={t().searchWidgets}
          aria-label={t().searchWidgets}
        />
      </div>
      <Show when={props.catalog.length > 0} fallback={<p class="dashboard-gallery__empty">{t().noWidgets}</p>}>
        <Show when={matches().length > 0} fallback={<p class="dashboard-gallery__empty">{t().noMatch({ query: query().trim() })}</p>}>
          <Show when={suggested().length > 0}>
            <section class="dashboard-gallery__section" aria-label={t().suggestedForYou}>
              <h3>
                <i class="ti ti-sparkles app-accent-text" aria-hidden="true" />
                {t().suggestedForYou}
              </h3>
              <div class="dashboard-gallery__grid">
                <For each={suggested()}>{card}</For>
              </div>
            </section>
          </Show>
          <For each={byApp()}>
            {(group) => (
              <section class="dashboard-gallery__section" aria-label={group.appName}>
                <h3>
                  <i class={group.appIcon} aria-hidden="true" />
                  {group.appName}
                </h3>
                <div class="dashboard-gallery__grid">
                  <For each={group.widgets}>{card}</For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

/**
 * Opens the gallery, as a wide dialog or, on a phone, a bottom sheet, and resolves with the widget and size the person
 * added, or `undefined` when they closed it.
 */
export const openDashboardGallery = (props: Omit<Parameters<typeof DashboardGallery>[0], "onAdd">, locale: string) => {
  const t = dashboardMessages.resolve([locale]).t;
  const phone = window.matchMedia(DASHBOARD_PHONE_QUERY).matches;
  return dialogCore.open<DashboardGalleryChoice>(
    (close, context) => {
      const gallery = <DashboardGallery {...props} onAdd={(choice) => close(choice)} />;
      const dismiss = () => void context.requestDismiss();
      return phone ? (
        <BottomSheet onDismiss={dismiss}>
          <BottomSheet.Header title={t.addWidget} subtitle={t.galleryDescription} close={dismiss} />
          <BottomSheet.Body>{gallery}</BottomSheet.Body>
        </BottomSheet>
      ) : (
        <PanelDialog>
          <PanelDialog.Header title={t.addWidget} subtitle={t.galleryDescription} close={dismiss} />
          <PanelDialog.Body>{gallery}</PanelDialog.Body>
        </PanelDialog>
      );
    },
    phone
      ? { ...bottomSheetOptions, history: true, ariaLabel: t.addWidget }
      : { ...panelDialogFixedOptions, panelClassName: `${panelDialogWidePanelClass} is-fixed`, history: true, ariaLabel: t.addWidget },
  );
};
