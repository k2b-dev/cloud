import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { Bar, Button, Canvas, Choice, Empty, Input, Menu, Pane, Row, Section, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { For, Match, Show, Switch } from "solid-js";
import NotebookSidebarBody from "../sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "../sidebar/notebook-sidebar-state";
import type { NotebookContext } from "../sidebar/types";
import GraphDisplays from "./GraphDisplays";
import GraphTable from "./GraphTable";
import { type GraphProps, useGraphView } from "./graph-controller";
import { GRAPH_DISPLAY_REGISTRY } from "./graph-displays";
import { matchesQuery } from "./model";

export type GraphWorkspaceProps = GraphProps & {
  ctx: NotebookContext;
  /** The page Links returns to from the sidebar's footer. */
  graphBack?: string;
};

/** The selector of the graph's empty states, where a way out hands the focus on. */
const EMPTY = '[data-k2-part="Empty"]';

/**
 * The Links graph of one notebook on v2: the notebook's sidebar, a head with the title, the search, As list and
 * close, the displays as tabs, the filters under them, and the chosen display in a `Canvas` or the notes as a table.
 * The address owns the view, so reload and Back show the same display, filters and search.
 */
export default function GraphWorkspace(props: GraphWorkspaceProps) {
  const sidebar = useNotebookSidebar({ ctx: props.ctx, current: "graph", graphBack: props.graphBack });
  const g = useGraphView(props, { root: () => document.querySelector<HTMLElement>("[data-k2-workspace]") ?? undefined, empty: EMPTY });
  const t = g.t;
  const linkOptions = () => [
    { value: "all" as const, label: t().graphLinksAll, icon: "circles" },
    { value: "linked" as const, label: t().graphLinksLinked, icon: "affiliate" },
    { value: "unlinked" as const, label: t().graphLinksUnlinked, icon: "circle-dashed" },
  ];
  const linkOption = () => linkOptions().find((option) => option.value === g.state().links) ?? linkOptions()[0]!;
  // Enter jumps to the first match: in the list to its row, without links to the note, else into the display.
  const jump = () => {
    const first = g.hits()[0];
    if (!first && (g.state().list || !g.hasLinks)) return;
    const workspace = document.querySelector("[data-k2-workspace]");
    if (g.state().list) workspace?.querySelector<HTMLElement>('[data-k2-part="Table"] a, [data-k2-part="Table"] button')?.focus();
    else if (!g.hasLinks) workspace?.querySelector<HTMLAnchorElement>(`a[href="${g.noteHref(first!.id)}"]`)?.focus();
    else if (g.display() === "timeline") g.focusNote();
    else g.focusNote(first?.id);
  };
  const listCount = () => t().graphNoteCount({ notes: g.query().trim() ? g.hits().length : g.notes().length, links: g.edges().length });

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree and its note menus. */}
      <WorkspaceNavigationProvider navigation={sidebar.mobileNavigation} label={props.ctx.notebook.name} />
      <Workspace
        sidebar={<NotebookSidebarBody sidebar={sidebar} current="graph" />}
        head={
          <Bar
            start={
              <>
                <Text weight="strong">{t().graphTitle}</Text>
                <Text muted>
                  {props.notebookName}
                  <Show when={g.current()}>{(note) => ` · ${t().graphFrom({ title: note().title || t().untitled })}`}</Show>
                </Text>
              </>
            }
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
            <Tabs
              label={t().graphDisplay}
              items={GRAPH_DISPLAY_REGISTRY.map((entry) => ({
                label: entry.label(t()),
                icon: entry.icon.replace(/^ti ti-/, ""),
                // k2b-ui gap: Tabs cannot mark a device default before the browser knows the width, so no tab is current
                // until then; the display itself is the same on both sides.
                current: !g.state().list && g.display() === entry.id,
                onClick: () => g.update({ display: entry.id, list: false }),
              }))}
            />
          }
          status={
            // Without links there is nothing to filter or zoom, so the row is left out entirely.
            <Show when={g.hasLinks}>
              <Bar
                start={
                  <>
                    <Menu
                      icon={linkOption().icon}
                      label={t().graphWhichNotes}
                      items={[
                        {
                          title: t().graphWhichNotes,
                          choice: g.state().links,
                          onChoose: (links) => g.update({ links: linkOptions().find((option) => option.value === links)?.value ?? "all" }),
                          items: linkOptions().map((option) => ({ label: option.label, icon: option.icon, value: option.value })),
                        },
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
                    >
                      {linkOption().label}
                    </Menu>
                    <Show when={!g.state().list && g.display() === "neighborhood"}>
                      <Choice
                        name="graph-depth"
                        label={t().graphDepth}
                        value={g.state().depth === 1 ? "1" : "2"}
                        options={[
                          { value: "1", label: t().graphDepthOne },
                          { value: "2", label: t().graphDepthTwo },
                        ]}
                        onChange={(depth) => g.update({ depth: depth === "1" ? 1 : 2 })}
                      />
                    </Show>
                  </>
                }
                end={
                  <>
                    <Button icon="minus" label={t().zoomOut} disabled={!g.showsGraph()} onClick={() => g.controls()?.zoom(1 / 1.25)} />
                    <Button icon="plus" label={t().zoomIn} disabled={!g.showsGraph()} onClick={() => g.controls()?.zoom(1.25)} />
                    <Button icon="focus-centered" label={t().fitGraph} disabled={!g.showsGraph()} onClick={() => g.controls()?.fit()} />
                  </>
                }
              />
            </Show>
          }
        >
          {/* A large notebook draws the pages around one page; the line says so from the first paint, so nothing moves. */}
          <Show when={props.graph.scope}>
            {(scope) => (
              <Bar
                start={
                  <Text type="meta">
                    {t().graphScope({
                      shown: g.model.notes.length,
                      total: scope().total,
                      title: g.model.byId.get(scope().around)?.title || t().untitled,
                    })}
                  </Text>
                }
              />
            )}
          </Show>
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
                summary={`${t().graphNoLinksDescription({ name: props.notebookName })} ${t().graphNoLinksHintBefore} /note ${t().graphNoLinksHintAfter}`}
              >
                <For each={g.model.notes}>
                  {(note) => (
                    <Row
                      icon="file-text"
                      lines={[note.title || t().untitled]}
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
              <Bar start={<Text type="meta">{listCount()}</Text>} />
              <GraphTable view={g} now={props.now} />
            </Match>
            <Match when={true}>
              {/* k2b-ui gap: a Canvas cannot fill its pane; the app's stylesheet lets this one take the pane's height
                  (app.css, `.notebook-graph`), because each display draws to the size it is given. */}
              <Canvas label={t().graphTitle}>
                <GraphDisplays graph={props} view={g} />
              </Canvas>
            </Match>
          </Switch>
        </Pane>
      </Workspace>
    </>
  );
}
