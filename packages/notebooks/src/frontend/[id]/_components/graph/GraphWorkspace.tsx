import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import type { NavigationController } from "@k2b/ui";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Empty, Input, Menu, Pane, Row, Section, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import type { NoteGraph } from "../../../../service/links";
import { notebookWorkspaceMessages } from "../../messages";
import GraphDisplays from "./GraphDisplays";
import GraphTable from "./GraphTable";
import { type GraphProps, useGraphView } from "./graph-controller";
import { GRAPH_DISPLAY_REGISTRY } from "./graph-displays";
import { matchesQuery } from "./model";

/** What frames the graph: the sidebar of its shell (the notebook's or Book's) and the phone menu. */
export type GraphShell = {
  sidebar: JSX.Element;
  navigation: NavigationController;
  navigationLabel: string;
  /** What stands over the drawing without moving it, such as Book's live-update notice. */
  overlay?: JSX.Element;
};

export type GraphFrameProps = Omit<GraphProps, "graph"> & {
  /** The graph, or none when the page could not load it. */
  graph: NoteGraph | null;
  shell: GraphShell;
};

/** The selector of the graph's empty states, where a way out hands the focus on. */
const EMPTY = '[data-k2-part="Empty"]';
const workspace = () => document.querySelector<HTMLElement>("[data-k2-workspace]") ?? undefined;

/**
 * The Links graph of one notebook on v2, in the notebook's shell or in Book's. Two rows stand above the content: the
 * workspace head (title, search, As list, close) and the pane head (the displays as tabs, which notes and areas,
 * depth, zoom). The chosen display stands in a `Canvas`, or the notes as a table. The address owns the view, so
 * reload and Back show the same display, filters and search.
 */
export default function GraphFrame(props: GraphFrameProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree. */}
      <WorkspaceNavigationProvider navigation={props.shell.navigation} label={props.shell.navigationLabel} />
      <Show
        when={props.graph}
        fallback={
          <Workspace
            sidebar={props.shell.sidebar}
            head={
              <Bar
                start={<Text weight="strong">{t().graphTitle}</Text>}
                end={<Button icon="x" label={t().closeGraph} href={props.backHref ?? `/app/notebooks/${props.notebookId}`} keep />}
              />
            }
          >
            <Pane label={t().graphTitle}>
              <Empty
                icon="affiliate"
                text={t().graphUnavailable}
                action={{ label: t().graphBackToNote, icon: "arrow-left", href: props.backHref ?? `/app/notebooks/${props.notebookId}` }}
              />
            </Pane>
          </Workspace>
        }
      >
        {(graph) => <GraphView {...props} graph={graph()} />}
      </Show>
    </>
  );
}

function GraphView(props: Omit<GraphFrameProps, "graph"> & { graph: NoteGraph }) {
  const g = useGraphView(props, { root: workspace, empty: EMPTY });
  const t = g.t;
  const linkOptions = () => [
    { value: "all" as const, label: t().graphLinksAll, icon: "circles" },
    { value: "linked" as const, label: t().graphLinksLinked, icon: "affiliate" },
    { value: "unlinked" as const, label: t().graphLinksUnlinked, icon: "circle-dashed" },
  ];
  // Enter jumps to the first match: in the list to its row, without links to the note, else into the display.
  const jump = () => {
    const first = g.hits()[0];
    if (!first && (g.state().list || !g.hasLinks)) return;
    if (g.state().list) workspace()?.querySelector<HTMLElement>('[data-k2-part="Table"] a, [data-k2-part="Table"] button')?.focus();
    else if (!g.hasLinks)
      [...(workspace()?.querySelectorAll<HTMLAnchorElement>('[data-k2-part="Section"] a[href]') ?? [])]
        .find((link) => link.getAttribute("href") === g.noteHref(first!.id))
        ?.focus();
    else if (g.display() === "timeline") g.focusNote();
    else g.focusNote(first?.id);
  };
  const listCount = () => t().graphNoteCount({ notes: g.query().trim() ? g.hits().length : g.notes().length, links: g.edges().length });
  // A large notebook's graph holds the pages around one page; the drawing, the list's count and the notes without links say so.
  const scopeLine = () => {
    const scope = props.graph.scope;
    return scope
      ? t().graphScope({ shown: g.model.notes.length, total: scope.total, title: g.model.byId.get(scope.around)?.title || t().untitled })
      : null;
  };
  // Umgebung around a note whose links the filters hide, or that has none: the display gives way to a way out.
  const localEmpty = () => {
    const current = g.current();
    if (g.state().list || g.display() !== "neighborhood" || !current) return null;
    if (g.notes().some((note) => current.neighbours.has(note.id))) return null;
    const title = current.title || t().untitled;
    return current.deg > 0
      ? { icon: "filter", text: t().graphLocalFilteredTitle({ title }), action: { label: t().graphResetFilters, onClick: g.resetFilters } }
      : {
          icon: "topology-star-3",
          text: t().graphLocalEmpty({ title }),
          action: { label: t().graphShowWholeNotebook, icon: "affiliate", onClick: () => g.leaveEmpty({ display: "network" }) },
        };
  };
  // A new centre whose links the filters hide replaces the display with its way out, which takes the focus.
  const focusEmpty = () => requestAnimationFrame(() => workspace()?.querySelector<HTMLElement>(`${EMPTY} :is(button, a[href])`)?.focus());

  return (
    <Workspace
      sidebar={props.shell.sidebar}
      head={
        // the title only: the notebook stands in the sidebar and the note the graph started from is ringed in it, and a
        // second line of words would push close off a phone's head
        <Bar
          start={<Text weight="strong">{t().graphTitle}</Text>}
          end={
            <>
              <Show when={g.model.notes.length > 0}>
                <Input
                  type="search"
                  icon="search"
                  label={t().graphFindLabel}
                  placeholder={t().graphFind}
                  value={g.query()}
                  onInput={(q) => g.update({ q })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    jump();
                  }}
                  end={
                    <Show when={g.query().trim()}>
                      <Text type="meta">{t().graphHits({ count: g.hits().length })}</Text>
                    </Show>
                  }
                />
                <Button
                  icon="list-details"
                  label={t().graphAsList}
                  pressed={g.state().list}
                  keep
                  onClick={() => g.update({ list: !g.state().list })}
                />
              </Show>
              <Button icon="x" label={t().closeGraph} href={g.closeHref()} keep />
            </>
          }
        />
      }
    >
      <Pane
        label={t().graphTitle}
        head={
          <Bar
            start={
              <>
                <Tabs
                  label={t().graphDisplay}
                  items={GRAPH_DISPLAY_REGISTRY.map((entry) => ({
                    label: entry.label(t()),
                    icon: entry.icon.replace(/^ti ti-/, ""),
                    // k2b-ui gap: Tabs cannot mark a device default before the browser knows the width, so no tab is
                    // current until then; the display itself is the same on both sides.
                    current: !g.state().list && g.display() === entry.id,
                    onClick: () => g.update({ display: entry.id, list: false }),
                  }))}
                />
                {/* the list's count stands in this row, so no row of its own goes above the table */}
                <Show when={g.state().list && g.model.notes.length > 0}>
                  <Text type="meta">{scopeLine() ? `${listCount()} · ${scopeLine()}` : listCount()}</Text>
                </Show>
              </>
            }
            end={
              // Without links there is nothing to filter or zoom.
              <>
                {/* the list's order, also where its columns give way to rows (the phone) */}
                <Show when={g.state().list && g.model.notes.length > 0}>
                  <Menu
                    icon="arrows-sort"
                    label={t().graphOrder}
                    items={[
                      {
                        title: t().graphOrder,
                        choice: g.state().sort ?? "tree",
                        onChoose: (sort) => g.update({ sort: sort === "changed" || sort === "changed-asc" ? sort : null }),
                        items: [
                          { label: t().graphOrderTree, value: "tree" },
                          { label: t().graphOrderNewest, value: "changed" },
                          { label: t().graphOrderOldest, value: "changed-asc" },
                        ],
                      },
                    ]}
                  />
                </Show>
                <Show when={g.hasLinks}>
                  {/* a symbol, so the phone keeps it in the head; the menu says which notes, depth and areas show */}
                  <Menu
                    icon="filter"
                    label={t().graphWhichNotes}
                    items={[
                      {
                        title: t().graphWhichNotes,
                        choice: g.state().links,
                        onChoose: (links) => g.update({ links: linkOptions().find((option) => option.value === links)?.value ?? "all" }),
                        items: linkOptions().map((option) => ({ label: option.label, icon: option.icon, value: option.value })),
                      },
                      // Umgebung's depth: one step or two around the centre
                      ...(!g.state().list && g.display() === "neighborhood"
                        ? [
                            {
                              title: t().graphDepth,
                              choice: g.state().depth === 1 ? "1" : "2",
                              onChoose: (depth: string) => g.update({ depth: depth === "1" ? 1 : 2 }),
                              items: [
                                { label: t().graphDepthOne, value: "1" },
                                { label: t().graphDepthTwo, value: "2" },
                              ],
                            },
                          ]
                        : []),
                      // k2b-ui gap: a menu entry takes no data colour, so an area shows no dot here; the graph keeps the colours.
                      {
                        title: t().graphAreas,
                        items: g.model.areas
                          .filter((area) => area.count > 0)
                          .map((area) => ({
                            label: g.areaName(area),
                            meta: String(area.count),
                            checked: !g.state().hide.includes(area.key),
                            onClick: () => g.toggleArea(area.key),
                          })),
                      },
                    ]}
                  />
                  <Button icon="minus" label={t().zoomOut} disabled={!g.showsGraph()} onClick={() => g.controls()?.zoom(1 / 1.25)} />
                  <Button icon="plus" label={t().zoomIn} disabled={!g.showsGraph()} onClick={() => g.controls()?.zoom(1.25)} />
                  <Button icon="focus-centered" label={t().fitGraph} disabled={!g.showsGraph()} onClick={() => g.controls()?.fit()} />
                </Show>
              </>
            }
          />
        }
      >
        <Switch>
          <Match when={g.model.notes.length === 0}>
            <Empty icon="affiliate" text={t().graphNoNotes} />
          </Match>
          <Match when={!g.hasLinks && !g.state().list}>
            <Empty
              icon="affiliate"
              text={t().graphNoLinks}
              action={{ label: t().graphBackToNote, icon: "arrow-left", href: g.closeHref() }}
            />
            <Section
              title={t().graphUnlinkedNotes({ count: g.model.notes.length })}
              summary={`${scopeLine() ? `${scopeLine()} ` : ""}${t().graphNoLinksDescription({ name: props.notebookName })} ${t().graphNoLinksHintBefore} /note ${t().graphNoLinksHintAfter}`}
            >
              <For each={g.model.notes}>
                {(note) => (
                  <Row
                    icon="file-text"
                    // the note in its area's colour, as the graph draws it; the area's name only where there are several
                    color={`var(--notebook-graph-area-${note.area.slot})`}
                    lines={[note.title || t().untitled]}
                    meta={g.model.areas.filter((area) => area.count > 0).length > 1 ? g.areaName(note.area) : undefined}
                    strong={!!g.query().trim() && matchesQuery(note, g.query())}
                    href={g.noteHref(note.id)}
                  />
                )}
              </For>
            </Section>
          </Match>
          <Match when={g.notes().length === 0}>
            <Empty
              icon="filter"
              text={
                g.model.areas.every((area) => area.count === 0 || g.state().hide.includes(area.key))
                  ? t().graphFilterAllHidden
                  : g.state().links === "unlinked"
                    ? t().graphFilterAllLinked
                    : t().graphFilterNoneLinked
              }
              action={{ label: t().graphResetFilters, onClick: g.resetFilters }}
            />
          </Match>
          <Match when={g.state().list}>
            <GraphTable view={g} now={props.now} />
          </Match>
          <Match when={true}>
            {/* k2b-ui gap: a Canvas cannot fill its pane; the app's stylesheet lets this one take the pane's height
                (app.css, `.notebook-graph`), because each display draws to the size it is given. */}
            <Canvas label={t().graphTitle}>
              <GraphDisplays
                graph={props}
                view={g}
                overlay={props.shell.overlay}
                focusEmpty={focusEmpty}
                // Umgebung keeps its announcement while its way out stands in the drawing's place
                neighborhoodEmpty={
                  <Show when={localEmpty()}>{(empty) => <Empty icon={empty().icon} text={empty().text} action={empty().action} />}</Show>
                }
              />
            </Canvas>
          </Match>
        </Switch>
      </Pane>
    </Workspace>
  );
}
