import type { GroupRelations } from "@k2b/cloud/contracts";
import { StatusBadge, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import RelationDetails from "./RelationDetails";
import { relationsMessages } from "./relations-messages";
import { type RelationsUrlState, relationsHref } from "./relations-view";

type Props = { relations: GroupRelations; state: RelationsUrlState };
type Node = GroupRelations["nodes"][number];
type Children = { status: "loading" | "error" | "done"; ids: string[] };
type Row = { key: string; id: string; level: number; parent?: string; back: boolean };

const query = (state: RelationsUrlState, change: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries({ managers: state.managers ? "true" : undefined, ...change }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * The relations as a tree, with the same details as the levels. One tab stop; arrow keys, Home, and End move, Enter
 * selects. Contained groups load when a group opens, one level at a time. A group already on the path becomes a
 * “leads back” row instead of a subtree, so cycles end.
 */
export default function RelationsTree(props: Props) {
  const locale = useLocale();
  const t = () => relationsMessages.resolve([locale()]).t;
  const [relations, setRelations] = createSignal(props.relations);
  const [nodes, setNodes] = createSignal(new Map(props.relations.nodes.map((node) => [node.id, node])));
  const [children, setChildren] = createSignal(new Map<string, Children>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [active, setActive] = createSignal<string>();
  const [detailsFailed, setDetailsFailed] = createSignal(false);
  const rowElements = new Map<string, HTMLLIElement>();

  const merge = (incoming: Node[]) =>
    setNodes((current) => {
      const next = new Map(current);
      for (const node of incoming) next.set(node.id, node);
      return next;
    });
  const node = (id: string) => nodes().get(id);
  const selectedId = () => relations().selected?.id;

  const load = async (id: string) => {
    if (children().get(id)?.status === "done" || children().get(id)?.status === "loading") return;
    setChildren((current) => new Map(current).set(id, { status: "loading", ids: [] }));
    try {
      const response = await apiClient.groups.relations.$get({ query: query(props.state, { focus: id, depth: "1", expand: "d1" }) });
      const result = await response.json();
      if (!response.ok || !("columns" in result)) throw new Error(t().treeLoadFailed);
      merge(result.nodes);
      const column = result.columns.find((entry) => entry.key === "d1");
      const ids = [...(column?.items.map((item) => item.id) ?? []), ...(column?.backs.map((back) => back.to) ?? [])];
      setChildren((current) => new Map(current).set(id, { status: "done", ids }));
    } catch {
      setChildren((current) => new Map(current).set(id, { status: "error", ids: [] }));
    }
  };

  const toggle = (row: Row, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
    if (open) void load(row.id);
  };

  // Once all top groups are open, every later answer keeps them all.
  const [allRoots, setAllRoots] = createSignal(false);
  const reload = async (id: string | undefined, all: boolean) => {
    setDetailsFailed(false);
    try {
      const response = await apiClient.groups.relations.$get({
        query: query(props.state, { focus: props.state.focus, selected: id, view: "list", expand: all ? "roots" : undefined }),
      });
      const result = await response.json();
      if (!response.ok || !("columns" in result)) throw new Error(t().errorTitle);
      merge(result.nodes);
      setRelations(result);
      setAllRoots(all);
      return true;
    } catch {
      setDetailsFailed(true);
      return false;
    }
  };
  const select = async (id: string) => {
    // Selection is part of the URL, so a reload shows the same details.
    if (await reload(id, allRoots())) window.history.replaceState(window.history.state, "", relationsHref(props.state, { sel: id }));
  };

  const rows = createMemo(() => {
    const out: Row[] = [];
    const walk = (id: string, level: number, path: string[], parent?: string) => {
      const key = [...path, id].join("/");
      out.push({ key, id, level, parent, back: false });
      if (!expanded().has(key)) return;
      for (const child of children().get(id)?.ids ?? []) {
        if (path.includes(child) || child === id)
          out.push({ key: `${key}/back:${child}`, id: child, level: level + 1, parent: key, back: true });
        else walk(child, level + 1, [...path, id], key);
      }
    };
    for (const root of relations().roots?.ids ?? []) walk(root, 1, []);
    return out;
  });
  const current = () =>
    rows().find((row) => row.key === active()) ?? rows().find((row) => row.id === selectedId() && !row.back) ?? rows()[0];

  const move = (row: Row | undefined) => {
    if (!row) return;
    setActive(row.key);
    rowElements.get(row.key)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const list = rows();
    const at = list.findIndex((row) => row.key === current()?.key);
    const row = list[at];
    if (!row) return;
    const hasChildren = !row.back && (node(row.id)?.contains ?? 0) > 0;
    const open = expanded().has(row.key);
    const actions: Record<string, () => void> = {
      ArrowDown: () => move(list[at + 1]),
      ArrowUp: () => move(list[at - 1]),
      Home: () => move(list[0]),
      End: () => move(list[list.length - 1]),
      ArrowRight: () => {
        if (hasChildren && !open) toggle(row, true);
        else if (open && list[at + 1]?.parent === row.key) move(list[at + 1]);
      },
      ArrowLeft: () => {
        if (open) toggle(row, false);
        else move(list.find((entry) => entry.key === row.parent));
      },
      Enter: () => void select(row.id),
      " ": () => void select(row.id),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
      <div class="min-h-[24rem] min-w-0 flex-1 overflow-auto rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface)] p-2">
        <ul role="tree" aria-label={t().treeLabel} class="text-[13.5px]">
          {/* Keyed by path, so opening a group keeps the rows and the focus that are already there. */}
          <For each={rows().map((entry) => entry.key)}>
            {(key) => {
              const row = rows().find((entry) => entry.key === key)!;
              const info = () => node(row.id);
              const hasChildren = () => !row.back && (info()?.contains ?? 0) > 0;
              const open = () => expanded().has(row.key);
              const state = () => children().get(row.id);
              return (
                <li
                  ref={(element) => rowElements.set(row.key, element)}
                  role="treeitem"
                  aria-level={row.level}
                  aria-expanded={hasChildren() ? open() : undefined}
                  aria-selected={!row.back && selectedId() === row.id}
                  aria-busy={open() && state()?.status === "loading" ? "true" : undefined}
                  tabindex={current()?.key === row.key ? 0 : -1}
                  class="outline-none [&:focus-visible>div]:outline-2 [&:focus-visible>div]:-outline-offset-2 [&:focus-visible>div]:outline-[var(--k2b-focus-ring)]"
                  onFocus={() => setActive(row.key)}
                  onKeyDown={onKeyDown}
                  onClick={() => {
                    setActive(row.key);
                    if (hasChildren()) toggle(row, !open());
                    void select(row.id);
                  }}
                >
                  <div
                    class={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-[var(--ui-radius-control)] px-1.5 ${!row.back && selectedId() === row.id ? "bg-[var(--ui-app-selected)] text-[var(--ui-app-accent-text)]" : "hover:bg-[var(--ui-hover)]"}`}
                    style={{ "padding-left": `${(row.level - 1) * 18 + 6}px` }}
                  >
                    <span class="w-5 shrink-0 text-center text-dimmed" aria-hidden="true">
                      {row.back ? "↺" : hasChildren() ? (open() ? "▾" : "▸") : ""}
                    </span>
                    <Show
                      when={!row.back}
                      fallback={
                        <span class="truncate text-[var(--k2b-warning-text)]">{t().treeBack({ name: info()?.name ?? row.id })}</span>
                      }
                    >
                      <span class="truncate">{info()?.name ?? row.id}</span>
                      <Show when={info()?.inCycle}>
                        <StatusBadge tone="warning" variant="chip" icon={null} label={t().treeCycle} />
                      </Show>
                      <span class="ml-auto shrink-0 pl-2 text-xs text-dimmed">
                        {t().meta({ ipa: info()?.provider === "ipa", contains: info()?.contains ?? 0, members: info()?.members ?? 0 })}
                      </span>
                    </Show>
                  </div>
                  <Show when={open() && state()?.status === "error"}>
                    <p class="py-1 text-xs text-[var(--k2b-danger-text)]" style={{ "padding-left": `${row.level * 18 + 32}px` }}>
                      {t().treeLoadFailed}
                    </p>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={relations().roots?.hidden}>
          {(hidden) => (
            <button
              type="button"
              class="mt-1 flex min-h-8 items-center rounded-[var(--ui-radius-control)] px-1.5 text-[12.5px] text-[var(--k2b-action)] hover:bg-[var(--ui-hover)] focus-visible:outline-2 focus-visible:outline-[var(--k2b-focus-ring)]"
              onClick={() => void reload(selectedId(), true)}
            >
              {t().more({ count: hidden() })}
            </button>
          )}
        </Show>
      </div>
      <aside class="w-full shrink-0 md:w-[17.5rem]" aria-label={relations().selected ? node(relations().selected!.id)?.name : undefined}>
        <Show when={detailsFailed()}>
          <p class="mb-2 text-xs text-[var(--k2b-danger-text)]">{t().errorTitle}</p>
        </Show>
        <RelationDetails
          relations={relations()}
          t={t()}
          pick={(id, name) => (
            <button
              type="button"
              class="max-w-full truncate rounded-[var(--ui-radius-control)] px-1.5 py-0.5 -ml-1.5 text-left text-[var(--k2b-action)] hover:bg-[var(--ui-hover)] focus-visible:outline-2 focus-visible:outline-[var(--k2b-focus-ring)]"
              onClick={() => void select(id)}
            >
              {name}
            </button>
          )}
        />
      </aside>
    </div>
  );
}
