import { navigateTo } from "@k2b/ssr/nav";
import { Button, ButtonLink, IconButton, IconButtonLink, Placeholder, SelectChip, TextInput, Toolbar, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { NoteGraph } from "../../../../service/links";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { createNavigationHidden, NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "../sidebar/navigation-visibility";
import GraphList from "./GraphList";
import { GraphDisplaySwitcher, graphDisplayLabel } from "./graph-displays";
import { buildGraphModel, type GraphLinksFilter, matchesQuery, visibleEdges, visibleNotes } from "./model";
import NetworkDisplay, { type GraphZoomControls } from "./NetworkDisplay";
import { GRAPH_QUERY_MAX, type GraphViewState, normalizeGraphViewState, writeGraphViewState } from "./view-state";

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
  const model = buildGraphModel(props.graph);
  const [state, setState] = createSignal<GraphViewState>(props.view);
  const navigationHidden = createNavigationHidden(props.navigationHidden);
  const [controls, setControls] = createSignal<GraphZoomControls | null>(null);
  let focusNote: ((id: string) => void) | undefined;

  // The state is normalized with the URL's own limits first, so what renders is what a reload restores.
  const update = (patch: Partial<GraphViewState>) => {
    const next = normalizeGraphViewState({ ...state(), ...patch });
    setState(next);
    const url = writeGraphViewState(new URL(window.location.href), next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // The search changes neither the visible notes nor the view; only the filters do.
  const filterKey = createMemo(() => `${state().links}|${state().hide.join(",")}`);
  const notes = createMemo(() => {
    filterKey();
    return untrack(() => visibleNotes(model, { links: state().links, hide: state().hide }));
  });
  const visibleIds = createMemo(() => new Set(notes().map((note) => note.id)));
  const edges = createMemo(() => visibleEdges(model, visibleIds()));
  const query = () => state().q;
  const hits = createMemo(() => (query().trim() ? notes().filter((note) => matchesQuery(note, query())) : []));
  const currentId = () => (props.selectedNoteId && model.byId.has(props.selectedNoteId) ? props.selectedNoteId : null);
  const current = () => (currentId() ? model.byId.get(currentId()!) : undefined);
  const hasLinks = model.edges.length > 0;
  const noteHref = (id: string) => buildNoteUrl(props.notebookId, id, props.from);
  const open = (id: string) => navigateTo(noteHref(id));
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
  const areaName = (title: string | null) => title ?? t().graphTopLevel;
  const navigationLabel = () => (navigationHidden() ? t().showNavigation : t().hideNavigation);
  const showsGraph = () => !state().list && hasLinks && notes().length > 0;

  return (
    <div class="notebook-graph" data-display={state().display} data-list={state().list ? "" : undefined}>
      <Toolbar label={t().graphTools} class="notebook-graph__head">
        {/* The navigation sidebar exists from md up; phones keep the header's menu. */}
        <div class={`hidden shrink-0 ${navigationHidden() ? "md:flex" : "lg:flex"}`}>
          <Tooltip.Anchor content={navigationLabel()}>
            <IconButton
              label={navigationLabel()}
              tooltip={false}
              size="sm"
              aria-expanded={!navigationHidden()}
              aria-controls={NOTEBOOK_NAVIGATION_ID}
              onClick={() => setNavigationHidden(!navigationHidden())}
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
        <GraphDisplaySwitcher value={state().display} onChange={(display) => update({ display })} />
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
              if (!first) return;
              if (state().list) document.querySelector<HTMLAnchorElement>(".notebook-graph__list-title")?.focus();
              else if (!hasLinks) document.querySelector<HTMLAnchorElement>(".notebook-graph__unlinked a[data-match]")?.focus();
              else focusNote?.(first.id);
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
                  <span class="notebook-graph__area-name">{areaName(area.title)}</span>
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
            <Placeholder class="absolute inset-0" variant="panel" icon="ti ti-affiliate" description={t().graphNoNotes} />
          </Match>
          <Match when={!hasLinks && !state().list}>
            <Placeholder
              class="absolute inset-0"
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
          </Match>
          <Match when={notes().length === 0}>
            <Placeholder
              class="absolute inset-0"
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
            <NetworkDisplay
              model={model}
              notes={notes()}
              edges={edges()}
              currentId={currentId()}
              query={query()}
              notebookName={props.notebookName}
              displayName={graphDisplayLabel(state().display, t())}
              now={props.now}
              filterKey={filterKey()}
              onOpen={open}
              onClearQuery={() => update({ q: "" })}
              controls={setControls}
              focusRequest={(focus) => {
                focusNote = focus;
              }}
            />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
