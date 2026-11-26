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
} from "@k2b/ui";
import { For, Match, Show, Switch } from "solid-js";
import { NOTEBOOK_NAVIGATION_ID } from "../sidebar/navigation-visibility";
import CircleDisplay from "./CircleDisplay";
import GraphList from "./GraphList";
import { type GraphProps, useGraphView } from "./graph-controller";
import { GraphDisplaySwitcher, graphDisplayLabel } from "./graph-displays";
import { type GraphLinksFilter, matchesQuery } from "./model";
import NeighborhoodDisplay from "./NeighborhoodDisplay";
import NetworkDisplay from "./NetworkDisplay";
import TimelineDisplay from "./TimelineDisplay";
import { DEFAULT_GRAPH_DISPLAY, GRAPH_QUERY_MAX, PHONE_GRAPH_DISPLAY } from "./view-state";

/**
 * The Links graph of one notebook in the v1 frame (Book's graph, until Book runs on v2): a toolbar, filters, and the
 * chosen display or the full-width list. Its state is the shared graph view (`graph-controller.ts`).
 */
export default function NotebookGraph(props: GraphProps) {
  let root!: HTMLDivElement;
  const {
    t,
    model,
    hasLinks,
    state,
    display,
    controls,
    setControls,
    focusNote,
    setFocusNote,
    update,
    recenter,
    filterKey,
    notes,
    visibleIds,
    edges,
    query,
    hits,
    currentId,
    current,
    noteHref,
    open,
    networkLayout,
    closeHref,
    claimFocus,
    leaveEmpty,
    resetFilters,
    toggleArea,
    areaName,
    showsGraph,
  } = useGraphView(props, { root: () => root, empty: ".notebook-graph__empty" });
  const linkOptions = () => [
    { value: "all" as const, label: t().graphLinksAll, icon: "ti ti-circles" },
    { value: "linked" as const, label: t().graphLinksLinked, icon: "ti ti-affiliate" },
    { value: "unlinked" as const, label: t().graphLinksUnlinked, icon: "ti ti-circle-dashed" },
  ];

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
      focusRequest={setFocusNote}
      claimFocus={claimFocus}
    />
  );
  const circle = () => (
    <CircleDisplay
      model={model}
      notes={notes()}
      edges={edges()}
      currentId={currentId()}
      query={query()}
      notebookName={props.notebookName}
      displayName={graphDisplayLabel("circle", t())}
      now={props.now}
      filterKey={filterKey()}
      onOpen={open}
      onClearQuery={() => update({ q: "" })}
      controls={setControls}
      focusRequest={setFocusNote}
      claimFocus={claimFocus}
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
      onNetwork={() => leaveEmpty({ display: "network" })}
      onResetFilters={resetFilters}
      noteHref={noteHref}
      onOpen={open}
      onClearQuery={() => update({ q: "" })}
      controls={setControls}
      focusRequest={setFocusNote}
      claimFocus={claimFocus}
    />
  );

  return (
    <div ref={root} class="notebook-graph" data-display={display() ?? undefined} data-list={state().list ? "" : undefined}>
      <Toolbar label={t().graphTools} class="notebook-graph__head">
        {/* The workspace has no head here: this button opens the navigation as an overlay below a 64 rem app host and
            shows or hides the column from there; the shared controller runs it. Phones keep the header's menu (app.css). */}
        <div class="notebooks-navigation-toggle">
          <Tooltip.Anchor content={t().navigation}>
            <IconButton
              label={t().navigation}
              tooltip={false}
              size="sm"
              aria-controls={NOTEBOOK_NAVIGATION_ID}
              data-app-workspace-sidebar-toggle=""
            >
              <i class="ti ti-layout-sidebar" aria-hidden="true" />
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
              else if (display() === "timeline") focusNote();
              else focusNote(first?.id);
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

      {/* A large notebook draws the pages around one page; the line says so from the first paint, so nothing moves. */}
      <Show when={props.graph.scope}>
        {(scope) => (
          <p class="notebook-graph__scope" role="note">
            <i class="ti ti-zoom-in-area" aria-hidden="true" />
            <span>
              {t().graphScope({
                shown: model.notes.length,
                total: scope().total,
                title: model.byId.get(scope().around)?.title || t().untitled,
              })}
            </span>
          </p>
        )}
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
              sort={state().sort}
              onSortChange={(sort) => update({ sort })}
              rows={query().trim() ? hits() : notes()}
              visibleIds={visibleIds()}
              caption={t().graphNoteCount({ notes: query().trim() ? hits().length : notes().length, links: edges().length })}
              currentId={currentId()}
              now={props.now}
              noteHref={noteHref}
              onOpen={open}
            />
          </Match>
          <Match when={display() === "timeline"}>
            <TimelineDisplay
              model={model}
              notes={notes()}
              edges={edges()}
              currentId={currentId()}
              query={query()}
              notebookName={props.notebookName}
              now={props.now}
              timeZone={props.timeZone}
              noteHref={noteHref}
              onOpen={open}
              onClearQuery={() => update({ q: "" })}
              controls={setControls}
              focusRequest={setFocusNote}
              claimFocus={claimFocus}
            />
          </Match>
          <Match when={true}>
            <Show
              when={display() === null}
              fallback={display() === "circle" ? circle() : display() === "neighborhood" ? neighborhood() : network()}
            >
              <div class="notebook-graph__desktop-default">{DEFAULT_GRAPH_DISPLAY === "network" ? network() : neighborhood()}</div>
              <div class="notebook-graph__phone-default">{PHONE_GRAPH_DISPLAY === "neighborhood" ? neighborhood() : network()}</div>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
