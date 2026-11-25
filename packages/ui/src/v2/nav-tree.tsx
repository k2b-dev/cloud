import { createComputed, createMemo, For, type JSX, on, onMount, Show, untrack } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { type TreeParts, useTree } from "./behavior/lists";
import { Dot, Icon } from "./marks";
import { Menu, type MenuEntry } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import type { OnNavigate, Status } from "./types";

// ── Tree ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One place in a tree, such as a folder of Files or a page of a notebook. */
export type NavTreeNode = {
  /** Stable and unique in the whole tree. */
  key: string;
  label: string;
  /** A Tabler icon name, such as `folder`; places of one tree all have one or all have none. */
  icon?: string;
  /** Where the place leads; a node without one only folds its children open. */
  href?: string;
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  count?: number | string;
  /** Something new here. */
  dot?: Status;
  /** The children loaded so far. Leave out while they are not loaded and set `branch`. */
  children?: readonly NavTreeNode[];
  /** It has children that load the first time it opens (the tree's `load`). */
  branch?: boolean;
  /**
   * More children exist than `children` holds: a last entry "Weitere laden" loads the next page through the tree's
   * `loadMore`. A number says how many are still to come.
   */
  more?: true | number;
  /** The deeds of this place, such as "Umbenennen": a "…" at its end, a right-click, Shift+F10 or the menu key. */
  menu?: readonly MenuEntry[];
};

/**
 * A tree of places, such as the folders of Files or the pages of a notebook. Pressing a place opens its page;
 * pressing the arrow before it, or Right and Left, folds it open and shut without leaving the page. The open place is
 * marked and the way to it stands open; it must be among the loaded nodes, with its ancestors.
 */
export type NavTree = {
  /** The tree's name for assistive technology, such as "Ordner". */
  label: string;
  items: readonly NavTreeNode[];
  /** The key of the open place. */
  current?: string;
  /** The open branches. Leave out and the tree keeps them itself, starting with the way to `current`. */
  expanded?: readonly string[];
  onExpandedChange?: (expanded: string[]) => void;
  /**
   * Loads the children of a `branch` without `children` the first time it opens; the app then puts them into
   * `items`. While it runs the branch says so; a rejection marks it failed, and opening it again tries again.
   */
  load?: (key: string, context: { signal: AbortSignal }) => Promise<unknown>;
  /** More places stand at the top level than `items` holds (as a node's `more`). */
  more?: true | number;
  /** Loads the next page of the children of `key` (`null`: of the top level); the app adds them to `items`. */
  loadMore?: (key: string | null) => Promise<unknown>;
};

// The value of the "Weitere laden" entry of a level; no node key starts with a word joiner.
const MORE = "\u2060more:";
const moreOf = (parent: string | null) => `${MORE}${parent ?? ""}`;

/** The keys from the top down to the parent of `key`, or undefined when `key` is not among the loaded nodes. */
export const treePath = (nodes: readonly NavTreeNode[], key: string): string[] | undefined => {
  for (const node of nodes) {
    if (node.key === key) return [];
    const below = node.children && treePath(node.children, key);
    if (below) return [node.key, ...below];
  }
  return undefined;
};

const isBranch = (node: NavTreeNode) => node.branch === true || (node.children?.length ?? 0) > 0 || node.more !== undefined;

/** Keys stop at the tree; the "…" keeps its own keys and presses, which must not open the place. */
const stop = (event: Event) => event.stopPropagation();

/** A Shift+F10 or the menu key on a place opens its deeds, as a right-click does. */
const asksForMenu = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

const openMenuOf = (item: Element) => item.querySelector<HTMLElement>(":scope > .k2-nt-row > .k2-nt-menu > button")?.click();

/** The "…" of a place: out of the tab order (the tree is one stop; Shift+F10 opens it); its keys and presses stay its own. */
const TreeMenu = (props: { label: string; items: readonly MenuEntry[] }) => {
  let span: HTMLSpanElement | undefined;
  onMount(() => span?.querySelector("button")?.setAttribute("tabindex", "-1"));
  return (
    <span ref={span} class="k2-nt-menu" on:keydown={stop} on:click={stop} on:pointerdown={stop}>
      <Menu label={props.label} items={props.items} />
    </span>
  );
};

/** The tree of a `Nav` group: places of 32 px, one level 16 px further in, the arrow before the symbol. */
export const NavTreeView = (props: NavTree) => {
  const t = useUiMessages();
  const overlay = useOverlayMessages();
  const nodes = createMemo(() => {
    const all = new Map<string, NavTreeNode>();
    const walk = (list: readonly NavTreeNode[]) => {
      for (const node of list) {
        all.set(node.key, node);
        if (node.children) walk(node.children);
      }
    };
    walk(props.items);
    return all;
  });
  const way = () => (props.current === undefined ? [] : (treePath(props.items, props.current) ?? []));
  const childrenOf = (parent: string | null) => (parent === null ? props.items : (nodes().get(parent)?.children ?? []));
  let root: HTMLElement | undefined;
  const parts: TreeParts = useTree(() => ({
    mode: "none",
    current: props.current ?? null,
    expandOnPress: false,
    ...(props.expanded !== undefined ? { expanded: [...props.expanded] } : { defaultExpanded: untrack(way) }),
    onExpandedChange: (expanded) => props.onExpandedChange?.(expanded),
    loadChildren: (key, context) => {
      const node = nodes().get(key);
      return node && node.children === undefined && props.load ? props.load(key, context) : undefined;
    },
    onAction: (key, { event }) => {
      if (key.startsWith(MORE)) {
        const parent = key === moreOf(null) ? null : key.slice(MORE.length);
        const before = childrenOf(parent).length;
        return props.loadMore?.(parent).then(() => {
          // the focus goes on to the first place that came, where reading goes on
          const next = childrenOf(parent)[before];
          if (next) requestAnimationFrame(() => parts.controller.focus(next.key));
        });
      }
      const node = nodes().get(key);
      // a place without an address folds open and shut on a press; its arrow does that itself
      const onArrow = event?.target instanceof Element && event.target.closest(".k2-nt-chev");
      if (node && node.href === undefined && isBranch(node) && !onArrow) parts.controller.toggle(key);
      return undefined;
    },
  }));
  // A place that becomes the open one later (a page opened in place) shows itself: the way to it opens.
  createComputed(
    on(
      () => props.current,
      () => {
        const closed = way().filter((key) => !parts.controller.isExpanded(key));
        if (closed.length > 0) parts.controller.setExpanded([...parts.controller.getExpanded(), ...closed]);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    // the open place stands in view of the tree, never by moving the page around it
    const current = root?.querySelector<HTMLElement>('[role="treeitem"][aria-current="page"] > .k2-nt-row');
    if (root && current) {
      const top = current.offsetTop - root.offsetTop;
      if (top + current.offsetHeight > root.scrollTop + root.clientHeight) root.scrollTop = top - root.clientHeight / 2;
    }
  });

  const More = (more: { parent: string | null; count: true | number }) => (
    <parts.Item value={moreOf(more.parent)} label={t().loadMore({ count: undefined })} class="k2-nt-item">
      <div class="k2-ni k2-nt-row" data-more="">
        <span class="k2-nt-chev">
          <Icon name="loader-2" />
        </span>
        <parts.Label class="k2-ni-name">{t().loadMore({ count: more.count === true ? undefined : more.count })}</parts.Label>
      </div>
    </parts.Item>
  );

  const level = (list: readonly NavTreeNode[], parent: string | null, more: () => true | number | undefined): JSX.Element => (
    <>
      <For each={list}>{(node) => <Entry node={node} />}</For>
      <Show when={props.loadMore && more()}>{(count) => <More parent={parent} count={count()} />}</Show>
    </>
  );

  const Entry = (entry: { node: NavTreeNode }) => (
    <parts.Item
      value={entry.node.key}
      label={entry.node.label}
      branch={isBranch(entry.node)}
      class="k2-nt-item"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target !== event.currentTarget || !entry.node.menu || !asksForMenu(event)) return;
        event.preventDefault();
        if (event.currentTarget instanceof Element) openMenuOf(event.currentTarget);
      }}
      onContextMenu={(event: MouseEvent) => {
        // a right-click on this place's row, not on a place nested in it
        const item = event.currentTarget;
        if (!entry.node.menu || !(item instanceof Element) || !(event.target instanceof Element)) return;
        if (event.target.closest('[role="treeitem"]') !== item) return;
        event.preventDefault();
        openMenuOf(item);
      }}
    >
      <div class="k2-ni k2-nt-row" data-k2-part="Nav.Item" data-has-menu={entry.node.menu ? "" : undefined}>
        <Show when={isBranch(entry.node)} fallback={<span class="k2-nt-chev" />}>
          {/* the arrow; while the children load a turning circle, after a failure a red mark (opening again retries) */}
          <parts.Indicator class="k2-nt-chev">
            <Icon name="chevron-right" />
            <Icon name="loader-2" />
            <Icon name="alert-circle" />
          </parts.Indicator>
        </Show>
        <Show when={entry.node.icon}>{(icon) => <Icon name={icon()} />}</Show>
        <Show when={entry.node.href} fallback={<parts.Label class="k2-ni-name">{entry.node.label}</parts.Label>}>
          {(href) => (
            <parts.Link href={href()} onNavigate={entry.node.onNavigate} class="k2-ni-name">
              {entry.node.label}
            </parts.Link>
          )}
        </Show>
        <Show when={entry.node.dot}>{(status) => <Dot status={status()} />}</Show>
        <Show when={entry.node.count !== undefined}>
          <span class="k2-ni-count">{entry.node.count}</span>
        </Show>
        <Show when={entry.node.menu}>{(menu) => <TreeMenu label={overlay().actionsFor({ name: entry.node.label })} items={menu()} />}</Show>
      </div>
      <Show when={isBranch(entry.node)}>
        <parts.Group class="k2-nt-group">{level(entry.node.children ?? [], entry.node.key, () => entry.node.more)}</parts.Group>
      </Show>
    </parts.Item>
  );

  return (
    <parts.Root
      ref={(element: HTMLElement) => {
        root = element;
      }}
      class="k2-nt"
      data-k2-part="Nav.Tree"
      aria-label={props.label}
    >
      {level(props.items, null, () => props.more)}
    </parts.Root>
  );
};
