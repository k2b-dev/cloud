import type { GroupRelations } from "@k2b/cloud/contracts";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { RelationsText } from "./relations-messages";
import type { RelationsUrlState } from "./relations-view";

type Props = {
  relations: GroupRelations;
  state: RelationsUrlState;
  t: RelationsText;
  /** The group whose details show, or are on their way. */
  selected: string | undefined;
  select: (id: string) => void;
  /** Shows every top group, not only the first ones. */
  more: () => void;
};
type Node = GroupRelations["nodes"][number];
type Children = { status: "loading" | "error" | "done"; ids: string[] };
type Row = { key: string; id: string; level: number; parent?: string; back: boolean; position: number; size: number };

const query = (state: RelationsUrlState, change: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries({ managers: state.managers ? "true" : undefined, ...change }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

// Drawn inside the page's Canvas with v2's tokens: rows of 32 px, the app's tint for the selection.
const rowFace = "flex min-h-8 cursor-pointer items-center gap-1.5 rounded-[var(--k2-r-control)] px-1.5";
const linkButton =
  "flex min-h-8 items-center rounded-[var(--k2-r-control)] px-1.5 text-[13px] text-[var(--k2-app-text)] hover:bg-[var(--k2-n100)] focus-visible:outline-2 focus-visible:outline-[var(--k2-blue)]";

/**
 * The relations as a tree. One tab stop; arrow keys, Home, and End move, Enter selects. Contained groups load when a
 * group opens, one level at a time. A group already on the path becomes a “leads back” row instead of a subtree, so
 * cycles end.
 *
 * k2b-ui gap: v2 has no tree (the ui-sdk tree collection is not exposed as a primitive); this drawing keeps the tree
 * behaviour Accounts had until a v2 `Tree` exists.
 */
export default function RelationTree(props: Props) {
  const [loaded, setLoaded] = createSignal(new Map<string, Node>());
  const [children, setChildren] = createSignal(new Map<string, Children>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [active, setActive] = createSignal<string>();
  const rowElements = new Map<string, HTMLLIElement>();
  const node = (id: string) => loaded().get(id) ?? props.relations.nodes.find((entry) => entry.id === id);

  const load = async (id: string) => {
    if (children().get(id)?.status === "done" || children().get(id)?.status === "loading") return;
    setChildren((current) => new Map(current).set(id, { status: "loading", ids: [] }));
    try {
      const response = await apiClient.groups.relations.$get({ query: query(props.state, { focus: id, depth: "1", expand: "d1" }) });
      const result = await response.json();
      if (!response.ok || !("columns" in result)) throw new Error(props.t.treeLoadFailed({ name: node(id)?.name ?? id }));
      setLoaded((current) => {
        const next = new Map(current);
        for (const entry of result.nodes) next.set(entry.id, entry);
        return next;
      });
      const column = result.columns.find((entry) => entry.key === "d1");
      const ids = [...(column?.items.map((item) => item.id) ?? []), ...(column?.backs.map((back) => back.to) ?? [])];
      setChildren((current) => new Map(current).set(id, { status: "done", ids }));
    } catch {
      setChildren((current) => new Map(current).set(id, { status: "error", ids: [] }));
    }
  };
  const failed = () => [...children()].filter(([, entry]) => entry.status === "error").map(([id]) => id);

  const toggle = (row: Row, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
    if (open) void load(row.id);
  };

  const rows = createMemo(() => {
    const out: Row[] = [];
    const walk = (id: string, level: number, path: string[], position: number, size: number, parent?: string) => {
      const key = [...path, id].join("/");
      out.push({ key, id, level, parent, back: false, position, size });
      if (!expanded().has(key)) return;
      const ids = children().get(id)?.ids ?? [];
      ids.forEach((child, index) => {
        if (path.includes(child) || child === id)
          out.push({
            key: `${key}/back:${child}`,
            id: child,
            level: level + 1,
            parent: key,
            back: true,
            position: index + 1,
            size: ids.length,
          });
        else walk(child, level + 1, [...path, id], index + 1, ids.length, key);
      });
    };
    const roots = props.relations.roots?.ids ?? [];
    roots.forEach((root, index) => {
      walk(root, 1, [], index + 1, roots.length);
    });
    return out;
  });
  const rowByKey = createMemo(() => new Map(rows().map((row) => [row.key, row])));
  const current = () => rowByKey().get(active() ?? "") ?? rows().find((row) => row.id === props.selected && !row.back) ?? rows()[0];

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
        else move(row.parent ? rowByKey().get(row.parent) : undefined);
      },
      Enter: () => props.select(row.id),
      " ": () => props.select(row.id),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div class="p-2 text-[13px] leading-5 text-[var(--k2-text)]">
      <ul role="tree" aria-label={props.t.treeLabel}>
        {/* Keyed by path, so opening a group keeps the rows and the focus that are already there. */}
        <For each={rows().map((entry) => entry.key)}>
          {(key) => {
            const row = () => rowByKey().get(key)!;
            const info = () => node(row().id);
            const hasChildren = () => !row().back && (info()?.contains ?? 0) > 0;
            const open = () => expanded().has(key);
            const loading = () => open() && children().get(row().id)?.status === "loading";
            const chosen = () => !row().back && props.selected === row().id;
            return (
              <li
                ref={(element) => rowElements.set(key, element)}
                role="treeitem"
                aria-level={row().level}
                aria-posinset={row().position}
                aria-setsize={row().size}
                aria-expanded={hasChildren() ? open() : undefined}
                aria-selected={chosen()}
                aria-busy={loading() ? "true" : undefined}
                tabindex={current()?.key === key ? 0 : -1}
                class="outline-none [&:focus-visible>div]:outline-2 [&:focus-visible>div]:-outline-offset-2 [&:focus-visible>div]:outline-[var(--k2-blue)]"
                onFocus={() => setActive(key)}
                onKeyDown={onKeyDown}
                onClick={(event) => {
                  setActive(key);
                  event.currentTarget.focus();
                  if (hasChildren()) toggle(row(), !open());
                  props.select(row().id);
                }}
              >
                <div
                  class={`${rowFace} ${chosen() ? "bg-[var(--k2-app-tint)] text-[var(--k2-app-text)]" : "hover:bg-[var(--k2-n100)]"}`}
                  style={{ "padding-left": `${(row().level - 1) * 18 + 6}px` }}
                >
                  <span class="w-5 shrink-0 text-center text-[var(--k2-subtle)]" aria-hidden="true">
                    {row().back ? "↺" : hasChildren() ? (open() ? "▾" : "▸") : ""}
                  </span>
                  <Show
                    when={!row().back}
                    fallback={
                      <span class="truncate text-[var(--k2-warn-ink)]">{props.t.treeBack({ name: info()?.name ?? row().id })}</span>
                    }
                  >
                    <span class="truncate">{info()?.name ?? row().id}</span>
                    <Show when={info()?.inCycle}>
                      <span class="shrink-0 rounded-[var(--k2-r-mark)] bg-[var(--k2-warn-tint)] px-1.5 text-[12px] text-[var(--k2-warn)]">
                        {props.t.treeCycle}
                      </span>
                    </Show>
                    <span class="ml-auto shrink-0 pl-2 text-[12px] text-[var(--k2-subtle)]">
                      <Show when={loading()}>
                        <span aria-hidden="true">{props.t.treeLoading} · </span>
                      </Show>
                      {props.t.meta({ ipa: info()?.provider === "ipa", contains: info()?.contains ?? 0, members: info()?.members ?? 0 })}
                    </span>
                  </Show>
                </div>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={props.relations.roots?.hidden}>
        {(hidden) => (
          <button type="button" class={`mt-1 ${linkButton}`} onClick={() => props.more()}>
            {props.t.more({ count: hidden() })}
          </button>
        )}
      </Show>
      {/* Outside the tree, so a failure is never part of a row's name. */}
      <div role="status">
        <For each={failed()}>
          {(id) => (
            <p class="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--k2-bad)]">
              {props.t.treeLoadFailed({ name: node(id)?.name ?? id })}
              <button
                type="button"
                class={linkButton}
                onClick={() => {
                  setChildren((currentChildren) => {
                    const next = new Map(currentChildren);
                    next.delete(id);
                    return next;
                  });
                  void load(id);
                }}
              >
                {props.t.retry}
              </button>
            </p>
          )}
        </For>
      </div>
    </div>
  );
}
