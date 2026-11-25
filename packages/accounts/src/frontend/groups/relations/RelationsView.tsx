import type { GroupRelations } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Empty, Failed, Lookup, Menu, Notice, Pane, Popover, Row, Section, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { usePageSwap } from "../../lib/page-swap";
import { loadEntities } from "../detail/group-screen";
import RelationLevels from "./RelationLevels";
import RelationTree from "./RelationTree";
import { relationsMessages } from "./relations-messages";
import { parseRelationsUrl, type RecordRelationsState, relationsHref } from "./relations-view";

export type RelationsViewProps = {
  state: RecordRelationsState;
  /** The relations around the record's group; `none` when it has none to show (a personal group), null when they could not be read. */
  relations: GroupRelations | "none" | null;
  /** The parameters the record keeps for the way back (`list_*`). */
  context: string;
};

const sideWidth = { min: 280, default: 320 };

/**
 * A group record's relations view (administrators): which groups contain the record's group and which it contains, as
 * levels around it or as a tree of all groups, with the details of the chosen group beside them. Everything the view
 * shows lives in the address; the tree changes the chosen group in place and writes it into the address.
 */
export default function RelationsView(props: RelationsViewProps) {
  const locale = useLocale();
  const t = createMemo(() => relationsMessages.resolve([locale()]).t);
  const { openPage, showChanges } = usePageSwap();
  const initial = props.relations && props.relations !== "none" ? props.relations : null;
  // What the tree loaded since the page came: the details and the top groups.
  const [loaded, setLoaded] = createSignal(initial);
  const [selection, setSelection] = createSignal(initial?.selected?.id);
  const [detailsFailed, setDetailsFailed] = createSignal(false);
  const [allRoots, setAllRoots] = createSignal(false);
  let pending: AbortController | undefined;
  onCleanup(() => pending?.abort());

  const href = (change: Partial<RecordRelationsState> = {}) => relationsHref(props.state, change, props.context);
  // The tree changes the selection in the URL without a new page; a control starts from the URL as it is now.
  const go = (change: Partial<RecordRelationsState>) => {
    const now = parseRelationsUrl((name) => new URLSearchParams(window.location.search).get(name) ?? undefined);
    void openPage(relationsHref({ ...now, focus: props.state.focus }, change, props.context));
  };

  /** Reads the details of one group (and, with `all`, every top group) for the tree, in place. */
  const reload = async (id: string | undefined, all: boolean) => {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      const query = Object.fromEntries(
        Object.entries({
          managers: props.state.managers ? "true" : undefined,
          focus: props.state.focus,
          selected: id,
          view: "list",
          expand: all ? "roots" : undefined,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const response = await apiClient.groups.relations.$get({ query }, { init: { signal: controller.signal } });
      const result = await response.json();
      if (!response.ok || !("columns" in result)) throw new Error(t().errorTitle);
      if (controller.signal.aborted) return false;
      setLoaded(result);
      setAllRoots(all);
      setDetailsFailed(false);
      return true;
    } catch {
      if (!controller.signal.aborted) setDetailsFailed(true);
      return false;
    }
  };
  const select = async (id: string) => {
    setSelection(id);
    // Selection is part of the URL, so a reload shows the same details.
    if (await reload(id, allRoots())) window.history.replaceState(window.history.state, "", href({ sel: id }));
  };

  const name = (id: string) => loaded()?.nodes.find((node) => node.id === id)?.name ?? id;
  const selected = () => loaded()?.selected ?? null;
  const node = () => loaded()?.nodes.find((entry) => entry.id === selected()?.id);
  /** A group in a details list: a link on the levels, a choice in place in the tree. */
  const pickHref = (id: string) => (props.state.view === "list" ? undefined : href({ sel: id }));
  const pickInPlace = (id: string) => (props.state.view === "list" ? () => void select(id) : undefined);
  const detailList = (label: string, entries: { ids: string[]; total: number } | null) => (
    <Show when={entries}>
      {(shown) => (
        <Section title={label}>
          <Show when={shown().total > 0} fallback={<Text muted>{t().none}</Text>}>
            <For each={shown().ids}>
              {(id) => <Row icon="users-group" lines={[name(id)]} href={pickHref(id)} onOpen={pickInPlace(id)} />}
            </For>
            <Show when={shown().total > shown().ids.length}>
              <Text type="meta">{t().andMore({ count: shown().total - shown().ids.length })}</Text>
            </Show>
          </Show>
        </Section>
      )}
    </Show>
  );
  /** The chosen group's own record, opened on this view: it becomes the focus. */
  const focusHref = (id: string) => (id === props.state.focus ? undefined : href({ focus: id, sel: undefined, expand: [] }));

  return (
    <Show
      when={props.relations !== null}
      fallback={<Failed text={`${t().errorTitle}. ${t().errorText}`} onRetry={() => void showChanges()} />}
    >
      <Show when={initial} fallback={<Empty icon="hierarchy-3" text={t().noRelations} />}>
        {(relations) => (
          <>
            <Show when={relations().cycles.first}>
              {(first) => (
                <Notice
                  tone="warn"
                  icon="refresh-alert"
                  title={t().cycles({ count: relations().cycles.count })}
                  actions={
                    first() === props.state.focus
                      ? undefined
                      : [{ label: t().showCycle, href: href({ focus: first(), sel: undefined, expand: [] }) }]
                  }
                >
                  {t().cyclesNotice}
                </Notice>
              )}
            </Show>
            <Show when={relations().truncated || !relations().managerCyclesComplete || !relations().cyclesComplete}>
              <Notice tone="warn" icon="alert-triangle">
                {t().truncated}
              </Notice>
            </Show>
            <Pane.Split>
              <Pane
                label={t().relations}
                scrollKey="accounts-group-relations"
                status={
                  <Bar
                    start={
                      <Text>
                        {`${t().groupCount({ count: relations().groupCount })} · ${
                          !relations().cyclesComplete
                            ? t().cyclesIncomplete
                            : relations().cycles.first
                              ? t().cycles({ count: relations().cycles.count })
                              : t().noCycles
                        }`}
                      </Text>
                    }
                    end={
                      <>
                        <Popover
                          icon="search"
                          label={t().searchLabel}
                          title={t().searchLabel}
                          content={
                            <Lookup
                              label={t().relations}
                              value={[]}
                              onChange={(values) => {
                                const id = values[0]?.slice("group:".length);
                                if (!id) return;
                                go(props.state.view === "list" ? { sel: id } : { focus: id, sel: undefined, expand: [] });
                              }}
                              load={loadEntities({ kinds: ["group"], exclude: { users: [], groups: [], agents: [] } }, { agent: "" })}
                            />
                          }
                        />
                        <Menu
                          variant="ghost"
                          items={[
                            {
                              title: t().view,
                              choice: props.state.view,
                              onChoose: (view) => go({ view: view === "list" ? "list" : "graph" }),
                              items: [
                                { label: t().graph, icon: "affiliate", value: "graph" },
                                { label: t().tree, icon: "list-tree", value: "list" },
                              ],
                            },
                            ...(props.state.view === "graph"
                              ? [
                                  {
                                    title: t().depth,
                                    choice: String(props.state.depth),
                                    onChoose: (depth: string) => go({ depth: Number(depth), expand: [] }),
                                    items: [1, 2, 3, 4].map((depth) => ({ label: String(depth), value: String(depth) })),
                                  },
                                ]
                              : []),
                          ]}
                        >
                          {props.state.view === "graph" ? `${t().graph} · ${t().depthValue({ depth: props.state.depth })}` : t().tree}
                        </Menu>
                        <Button
                          variant="ghost"
                          icon="user-star"
                          pressed={props.state.managers}
                          onClick={() => go({ managers: !props.state.managers })}
                        >
                          {t().managers}
                        </Button>
                      </>
                    }
                  />
                }
              >
                <Show
                  when={props.state.view === "graph"}
                  fallback={
                    <Canvas label={t().treeLabel}>
                      <RelationTree
                        relations={loaded() ?? relations()}
                        state={props.state}
                        t={t()}
                        selected={selection()}
                        select={(id) => void select(id)}
                        more={() => void reload(selection(), true)}
                      />
                    </Canvas>
                  }
                >
                  <Canvas label={t().relations}>
                    <div class="overflow-auto bg-[var(--k2-canvas)]" data-stage>
                      <div
                        class="flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1 px-4 pt-3 text-[12px] text-[var(--k2-subtle)]"
                        aria-hidden="true"
                      >
                        <span class="inline-flex items-center gap-1">
                          <i class="inline-block w-6 border-t-2 border-[var(--k2-n400)]" />
                          {t().legendContains}
                        </span>
                        <span class="inline-flex items-center gap-1">
                          <i class="inline-block w-6 border-t-2 border-dashed border-[var(--k2-warn-ink)]" />
                          {t().legendCycle}
                        </span>
                        <span>{t().legendShown}</span>
                      </div>
                      <RelationLevels relations={relations()} state={props.state} t={t()} href={(change) => href(change)} />
                    </div>
                  </Canvas>
                </Show>
              </Pane>
              <Pane side label={t().details} width={sideWidth}>
                <Show when={!detailsFailed()} fallback={<Failed text={t().errorTitle} onRetry={() => void select(selection() ?? "")} />}>
                  <Show when={selected() && node()} fallback={<Empty icon="hand-click" text={t().choose} />}>
                    {(chosen) => (
                      <>
                        <Section
                          icon="users-group"
                          title={chosen().name}
                          summary={`${chosen().provider === "ipa" ? "FreeIPA" : t().local} · ${t().directMembers({ count: chosen().members })}`}
                          actions={
                            focusHref(chosen().id)
                              ? [
                                  { label: t().openGroup, href: `/app/accounts/groups/${chosen().id}` },
                                  { label: t().makeFocus, href: focusHref(chosen().id) },
                                ]
                              : undefined
                          }
                        />
                        <Show when={selected()?.cycle}>
                          {(cycle) => (
                            <Notice tone="warn" icon="refresh-alert" title={t().cycleTitle}>
                              {t().cycleText({ path: cycle().path.map(name).join(" → "), size: cycle().size })}
                              {chosen().provider === "ipa" ? ` ${t().cycleIpa}` : ""}
                            </Notice>
                          )}
                        </Show>
                        <Show when={selected()?.managerCycle}>
                          {(cycle) => (
                            <Notice tone="warn" icon="refresh-alert" title={t().managerCycleTitle}>
                              {t().managerCycleText({ path: cycle().path.map(name).join(" → ") })}
                            </Notice>
                          )}
                        </Show>
                        {detailList(t().containedIn({ count: selected()?.parents.total ?? 0 }), selected()?.parents ?? null)}
                        {detailList(t().contains({ count: selected()?.children.total ?? 0 }), selected()?.children ?? null)}
                        {detailList(t().managesList({ count: selected()?.manages?.total ?? 0 }), selected()?.manages ?? null)}
                        {detailList(t().managedBy({ count: selected()?.managedBy?.total ?? 0 }), selected()?.managedBy ?? null)}
                      </>
                    )}
                  </Show>
                </Show>
              </Pane>
            </Pane.Split>
          </>
        )}
      </Show>
    </Show>
  );
}
