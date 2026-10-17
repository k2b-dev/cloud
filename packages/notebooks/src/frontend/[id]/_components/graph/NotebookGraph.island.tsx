import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  ButtonLink,
  IconButton,
  IconButtonLink,
  Placeholder,
  SegmentedControl,
  SelectChip,
  TextInput,
  Toolbar,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { NoteGraph } from "../../../../service/links";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { createNavigationHidden, NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "../sidebar/navigation-visibility";
import GraphList from "./GraphList";
import { GraphDisplaySwitcher, graphDisplayLabel } from "./graph-displays";
import { layoutNetworkInSlices, type NetPoint } from "./layout-net";
import { buildGraphModel, type GraphArea, type GraphLinksFilter, matchesQuery, visibleEdges, visibleNotes } from "./model";
import NeighborhoodDisplay from "./NeighborhoodDisplay";
import NetworkDisplay, { type GraphZoomControls } from "./NetworkDisplay";
import {
  DEFAULT_GRAPH_DISPLAY,
  GRAPH_QUERY_MAX,
  type GraphViewState,
  normalizeGraphViewState,
  PHONE_GRAPH_DISPLAY,
  PHONE_GRAPH_QUERY,
  resolveGraphDisplay,
  writeGraphViewState,
} from "./view-state";

const SEARCH_URL_DELAY_MS = 300;
const URL_RETRY_MS = 1000;

type Props = {
  notebookId: string;
  notebookName: string;
  /** The note the graph was opened from: it is labelled and ringed in the app's accent. */
  selectedNoteId: string | null;
  graph: NoteGraph;
  from?: PresentationMode;
  backHref?: string;
  /** View state parsed from the URL on the server, so the first paint shows the same display, filters and search. */
  view: GraphViewState;
  /** Server time, the base for relative dates on both sides. */
  now: string;
  navigationHidden: boolean;
};

/**
 * The Links graph of one notebook: a toolbar, filters, and the chosen display or the full-width list. The URL owns the
 * view state; changes replace the history entry, and opening a note is a normal navigation, so Back returns to the
 * same display, filters and search.
 */
export default function NotebookGraph(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const model = buildGraphModel(props.graph, locale());
  const hasLinks = model.edges.length > 0;
  const [state, setState] = createSignal<GraphViewState>(props.view);
  const [centreId, setCentreId] = createSignal(
    props.selectedNoteId && model.byId.has(props.selectedNoteId) ? props.selectedNoteId : (model.notes[0]?.id ?? null),
  );
  let centreChanged = false;
  const [phone, setPhone] = createSignal<boolean | null>(
    typeof window === "undefined" ? null : window.matchMedia(PHONE_GRAPH_QUERY).matches,
  );
  const display = createMemo(() => resolveGraphDisplay(state().display, phone()));
  const navigationHidden = createNavigationHidden(props.navigationHidden);
  const [controls, setControls] = createSignal<GraphZoomControls | null>(null);
  let focusNote: ((id?: string) => void) | undefined;
  let navigationToggle: HTMLDivElement | undefined;

  // The address follows the state. Typing in the search writes it once the typing pauses, since Safari limits how
  // often a page may replace its history entry; a write it refuses is tried again, and leaving the page writes first.
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  const writeUrl = () => {
    clearTimeout(urlTimer);
    urlTimer = undefined;
    const url = writeGraphViewState(new URL(window.location.href), state());
    if (centreChanged && centreId()) url.searchParams.set("note", centreId()!);
    try {
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      urlTimer = setTimeout(writeUrl, URL_RETRY_MS);
    }
  };
  const flushUrl = () => {
    if (urlTimer !== undefined) writeUrl();
  };
  // The state is normalized with the URL's own limits first, so what renders is what a reload restores.
  const update = (patch: Partial<GraphViewState>) => {
    setState(normalizeGraphViewState({ ...state(), ...patch }));
    if (Object.keys(patch).every((key) => key === "q")) {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(writeUrl, SEARCH_URL_DELAY_MS);
    } else writeUrl();
  };
  const recenter = (id: string) => {
    if (!model.byId.has(id) || id === centreId()) return;
    setCentreId(id);
    centreChanged = true;
    writeUrl();
  };
  onMount(() => {
    const media = window.matchMedia(PHONE_GRAPH_QUERY);
    const changed = () => setPhone(media.matches);
    media.addEventListener("change", changed);
    onCleanup(() => media.removeEventListener("change", changed));
    window.addEventListener("pagehide", flushUrl);
    onCleanup(() => {
      window.removeEventListener("pagehide", flushUrl);
      clearTimeout(urlTimer);
    });
  });

  // The search changes neither the visible notes nor the view; only the filters do.
  const filterKey = createMemo(() => `${state().links}|${state().hide.join(",")}`);
  // Without links there are no filters to show, so a saved filter in the address does not apply either.
  const notes = createMemo(() => {
    filterKey();
    return hasLinks ? untrack(() => visibleNotes(model, { links: state().links, hide: state().hide })) : model.notes;
  });
  const visibleIds = createMemo(() => new Set(notes().map((note) => note.id)));
  const edges = createMemo(() => visibleEdges(model, visibleIds()));
  const query = () => state().q;
  const hits = createMemo(() => (query().trim() ? notes().filter((note) => matchesQuery(note, query())) : []));
  const currentId = centreId;
  const current = () => (currentId() ? model.byId.get(currentId()!) : undefined);
  const noteHref = (id: string) => buildNoteUrl(props.notebookId, id, props.from);
  const open = (id: string, newTab = false) => {
    if (newTab) {
      window.open(noteHref(id), "_blank", "noopener");
      return;
    }
    flushUrl();
    navigateTo(noteHref(id));
  };
  // The layout runs once, when the network first shows, and is kept while the island lives, so returning from the list
  // or from an empty filter does not arrange the notes again or undo a drag.
  const layoutAbort = new AbortController();
  onCleanup(() => layoutAbort.abort());
  let layout: Promise<Map<string, NetPoint> | null> | undefined;
  const networkLayout = () => {
    layout ??= layoutNetworkInSlices(model, layoutAbort.signal);
    return layout;
  };
  const closeHref = () =>
    props.backHref ??
    (current()
      ? buildNoteUrl(props.notebookId, current()!.id, props.from)
      : `/app/notebooks/${props.notebookId}${props.from ? `?mode=${props.from}` : ""}`);
  const resetFilters = () => update({ links: "all", hide: [] });
  const linkOptions = () => [
    { value: "all" as const, label: t().graphLinksAll, icon: "ti ti-circles" },
    { value: "linked" as const, label: t().graphLinksLinked, icon: "ti ti-affiliate" },
    { value: "unlinked" as const, label: t().graphLinksUnlinked, icon: "ti ti-circle-dashed" },
  ];
  const toggleArea = (key: string) => {
    const hide = state().hide;
    update({ hide: hide.includes(key) ? hide.filter((item) => item !== key) : [...hide, key] });
  };
  const areaName = (area: GraphArea) => (area.index === 0 ? t().graphTopLevel : area.title || t().untitled);
  const navigationLabel = () => (navigationHidden() ? t().showNavigation : t().hideNavigation);
  const showsGraph = () =>
    !state().list &&
    hasLinks &&
    notes().length > 0 &&
    (display() !== "neighborhood" || notes().some((note) => current()?.neighbours.has(note.id)));

  const depthSegment = () => (
    <>
      <Toolbar.Separator />
      <div class="notebook-graph__depth">
        <span>{t().graphDepth}</span>
        <SegmentedControl<"1" | "2">
          size="sm"
          ariaLabel={t().graphDepth}
          value={state().depth === 1 ? "1" : "2"}
          options={[
            { value: "1", label: t().graphDepthOne },
            { value: "2", label: t().graphDepthTwo },
          ]}
          onValueChange={(depth) => update({ depth: depth === "1" ? 1 : 2 })}
        />
      </div>
    </>
  );
  const network = () => (
    <NetworkDisplay
      model={model}
      notes={notes()}
      edges={edges()}
      currentId={currentId()}
      query={query()}
      notebookName={props.notebookName}
      displayName={graphDisplayLabel("network", t())}
      now={props.now}
      filterKey={filterKey()}
      layout={networkLayout}
      onOpen={open}
      onClearQuery={() => update({ q: "" })}
      controls={setControls}
      focusRequest={(focus) => {
        focusNote = focus;
      }}
    />
  );
  const neighborhood = () => (
    <NeighborhoodDisplay
      model={model}
      notes={notes()}
      edges={edges()}
      currentId={currentId()}
      query={query()}
      notebookName={props.notebookName}
      displayName={graphDisplayLabel("neighborhood", t())}
      now={props.now}
      filterKey={filterKey()}
      depth={state().depth}
      onCentre={recenter}
      onNetwork={() => update({ display: "network" })}
      onResetFilters={resetFilters}
      noteHref={noteHref}
      onOpen={open}
      onClearQuery={() => update({ q: "" })}
      controls={setControls}
      focusRequest={(focus) => {
        focusNote = focus;
      }}
    />
  );

  return (
    <div class="notebook-graph" data-display={display() ?? undefined} data-list={state().list ? "" : undefined}>
      <Toolbar label={t().graphTools} class="notebook-graph__head">
        {/* The navigation sidebar sits beside the graph from lg up; between md and lg the toggle only brings a hidden
            navigation back, as the editor's does. Phones keep the header's menu. */}
        <div ref={navigationToggle} class={`hidden shrink-0 ${navigationHidden() ? "md:flex" : "lg:flex"}`}>
          <Tooltip.Anchor content={navigationLabel()}>
            <IconButton
              label={navigationLabel()}
              tooltip={false}
              size="sm"
              aria-expanded={!navigationHidden()}
              aria-controls={NOTEBOOK_NAVIGATION_ID}
              onClick={() => {
                const showing = navigationHidden();
                setNavigationHidden(!showing);
                // Between md and lg the toggle hides itself once the navigation is back. Focus moves into the
                // navigation when it can take it there, else to the graph's search, never to the page start.
                if (showing)
                  requestAnimationFrame(() => {
                    if (!navigationToggle || navigationToggle.getClientRects().length) return;
                    const navigation = document.getElementById(NOTEBOOK_NAVIGATION_ID);
                    for (const element of navigation?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []) {
                      element.focus();
                      if (document.activeElement === element) return;
                    }
                    navigationToggle.closest(".notebook-graph")?.querySelector<HTMLInputElement>(".notebook-graph__head input")?.focus();
                  });
              }}
            >
              <i
                class={`ti ${navigationHidden() ? "ti-layout-sidebar-left-expand" : "ti-layout-sidebar-left-collapse"}`}
                aria-hidden="true"
              />
            </IconButton>
          </Tooltip.Anchor>
        </div>
        <IconButtonLink href={closeHref()} size="sm" class="md:!hidden" label={t().closeGraph}>
          <i class="ti ti-chevron-left" aria-hidden="true" />
        </IconButtonLink>
        <div class="notebook-graph__title">
          <small>
            {props.notebookName}
            <Show when={current()}>
              {(note) => <span class="max-md:hidden"> · {t().graphFrom({ title: note().title || t().untitled })}</span>}
            </Show>
          </small>
          <strong>{t().graphTitle}</strong>
        </div>
        <div class="notebook-graph__display-switcher">
          <Show
            when={display() === null}
            fallback={<GraphDisplaySwitcher value={display() ?? DEFAULT_GRAPH_DISPLAY} onChange={(display) => update({ display })} />}
          >
            <div class="notebook-graph__desktop-default">
              <GraphDisplaySwitcher value={DEFAULT_GRAPH_DISPLAY} onChange={(display) => update({ display })} />
            </div>
            <div class="notebook-graph__phone-default">
              <GraphDisplaySwitcher value={PHONE_GRAPH_DISPLAY} onChange={(display) => update({ display })} />
            </div>
          </Show>
        </div>
        <Show when={model.notes.length > 0}>
          <TextInput
            type="search"
            class="notebook-graph__search"
            icon="ti ti-search"
            placeholder={t().graphFind}
            maxLength={GRAPH_QUERY_MAX}
            aria-label={t().graphFindLabel}
            value={query()}
            onValueChange={(q) => update({ q })}
            suffix={
              <span class="notebook-graph__hits" aria-live="polite" aria-atomic="true">
                <Show when={query().trim()}>
                  <span aria-hidden="true">{hits().length}</span>
                  <span class="sr-only">{t().graphHits({ count: hits().length })}</span>
                </Show>
              </span>
            }
            // Enter jumps to the first match. Esc clears a search field natively, which reports an empty value.
            onSubmit={() => {
              const first = hits()[0];
              if (!first && (state().list || !hasLinks)) return;
              if (state().list) document.querySelector<HTMLAnchorElement>(".notebook-graph__list-title")?.focus();
              else if (!hasLinks) document.querySelector<HTMLAnchorElement>(".notebook-graph__unlinked a[data-match]")?.focus();
              else focusNote?.(first?.id);
            }}
          />
          <Tooltip.Anchor content={t().graphAsList}>
            <IconButton
              label={t().graphAsList}
              tooltip={false}
              size="sm"
              aria-pressed={state().list}
              data-pressed={state().list ? "" : undefined}
              onClick={() => update({ list: !state().list })}
            >
              <i class="ti ti-list-details" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
        </Show>
        <Tooltip.Anchor content={t().closeGraph}>
          <IconButtonLink tooltip={false} href={closeHref()} size="sm" class="max-md:!hidden" label={t().closeGraph}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButtonLink>
        </Tooltip.Anchor>
      </Toolbar>

      {/* Without links there is nothing to filter or zoom, so the row is left out entirely. */}
      <Show when={hasLinks}>
        <Toolbar label={t().graphFilters} class="notebook-graph__filters">
          <SelectChip<GraphLinksFilter>
            aria-label={t().graphWhichNotes}
            size="sm"
            position="bottom-left"
            value={state().links}
            options={linkOptions()}
            onValueChange={(links) => update({ links })}
          />
          <Show when={!state().list && display() === "neighborhood"}>{depthSegment()}</Show>
          <Show when={!state().list && display() === null}>
            <div class="notebook-graph__desktop-default">
              <Show when={DEFAULT_GRAPH_DISPLAY === "neighborhood"}>{depthSegment()}</Show>
            </div>
            <div class="notebook-graph__phone-default">
              <Show when={PHONE_GRAPH_DISPLAY === "neighborhood"}>{depthSegment()}</Show>
            </div>
          </Show>
          <Toolbar.Separator />
          <div class="notebook-graph__areas" role="group" aria-label={t().graphAreas}>
            <For each={model.areas.filter((area) => area.count > 0)}>
              {(area) => (
                <Button
                  variant="ghost"
                  size="sm"
                  class="notebook-graph__area"
                  data-slot={area.slot}
                  aria-pressed={!state().hide.includes(area.key)}
                  onClick={() => toggleArea(area.key)}
                >
                  <span class="notebook-graph__dot" aria-hidden="true" />
                  <span class="notebook-graph__area-name">{areaName(area)}</span>
                  <span class="notebook-graph__count">{area.count}</span>
                </Button>
              )}
            </For>
          </div>
          <Toolbar.Group label={t().graphZoom} class={`notebook-graph__zoom max-md:!hidden ${showsGraph() ? "" : "invisible"}`}>
            <IconButton label={t().zoomOut} size="sm" disabled={!showsGraph()} onClick={() => controls()?.zoom(1 / 1.25)}>
              <i class="ti ti-minus" aria-hidden="true" />
            </IconButton>
            <IconButton label={t().zoomIn} size="sm" disabled={!showsGraph()} onClick={() => controls()?.zoom(1.25)}>
              <i class="ti ti-plus" aria-hidden="true" />
            </IconButton>
            <IconButton label={t().fitGraph} size="sm" disabled={!showsGraph()} onClick={() => controls()?.fit()}>
              <i class="ti ti-focus-centered" aria-hidden="true" />
            </IconButton>
          </Toolbar.Group>
        </Toolbar>
      </Show>

      <div class="notebook-graph__body">
        <Switch>
          <Match when={model.notes.length === 0}>
            <div class="notebook-graph__empty">
              <Placeholder variant="panel" icon="ti ti-affiliate" description={t().graphNoNotes} />
            </div>
          </Match>
          <Match when={!hasLinks && !state().list}>
            {/* Many unlinked notes can be taller than the canvas, so this state scrolls. */}
            <div class="notebook-graph__empty">
              <Placeholder
                variant="panel"
                icon="ti ti-affiliate"
                title={t().graphNoLinks}
                description={
                  <>
                    <p>
                      {t().graphNoLinksDescription({ name: props.notebookName })} {t().graphNoLinksHintBefore} <code>/note</code>{" "}
                      {t().graphNoLinksHintAfter}
                    </p>
                    <ul
                      class="notebook-graph__unlinked"
                      data-query={query().trim() ? "" : undefined}
                      aria-label={t().graphUnlinkedNotes({ count: model.notes.length })}
                    >
                      <For each={model.notes}>
                        {(note) => (
                          <li data-slot={note.area.slot}>
                            <a href={noteHref(note.id)} data-match={matchesQuery(note, query()) ? "" : undefined}>
                              <span class="notebook-graph__dot" aria-hidden="true" />
                              {note.title || t().untitled}
                            </a>
                          </li>
                        )}
                      </For>
                    </ul>
                  </>
                }
                action={
                  <ButtonLink variant="secondary" size="sm" href={closeHref()}>
                    <i class="ti ti-arrow-left" aria-hidden="true" />
                    {t().graphBackToNote}
                  </ButtonLink>
                }
              />
            </div>
          </Match>
          <Match when={notes().length === 0}>
            <div class="notebook-graph__empty">
              <Placeholder
                variant="panel"
                icon="ti ti-filter"
                title={t().graphFilterEmpty}
                description={
                  model.areas.every((area) => area.count === 0 || state().hide.includes(area.key))
                    ? t().graphFilterAllHidden
                    : state().links === "unlinked"
                      ? t().graphFilterAllLinked
                      : t().graphFilterNoneLinked
                }
                action={
                  <Button variant="secondary" size="sm" onClick={resetFilters}>
                    {t().graphResetFilters}
                  </Button>
                }
              />
            </div>
          </Match>
          <Match when={state().list}>
            <GraphList
              model={model}
              rows={query().trim() ? hits() : notes()}
              visibleIds={visibleIds()}
              caption={t().graphNoteCount({ notes: query().trim() ? hits().length : notes().length, links: edges().length })}
              currentId={currentId()}
              now={props.now}
              noteHref={noteHref}
              onOpen={open}
            />
          </Match>
          <Match when={true}>
            <Show when={display() === null} fallback={display() === "neighborhood" ? neighborhood() : network()}>
              <div class="notebook-graph__desktop-default">{DEFAULT_GRAPH_DISPLAY === "network" ? network() : neighborhood()}</div>
              <div class="notebook-graph__phone-default">{PHONE_GRAPH_DISPLAY === "neighborhood" ? neighborhood() : network()}</div>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
