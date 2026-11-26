import { createComputed, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { type TreeParts, useTree } from "./behavior/lists";
import { announceText } from "./behavior/treegrid";
import { type DragMove, useDragMove } from "./drag";
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
  /**
   * Places drag onto other places, and places that are folders take places, rows, tiles and files of the same scope
   * (see `DragMove`); a closed folder the pointer rests on opens. The place's `menu` stays the way for keys and touch.
   */
  drag?: DragMove;
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
  // No Tab stop and hidden from assistive technology (`pointerOnly`, from the first markup on; a tree owns only its
  // items): the keys open the same menu with Shift+F10 on the tree item, a phone with a long press on the row
  // (`Menu.Context`). The focus a closing menu gives back to it goes to the tree item instead.
  const back = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && event.target.matches("button[aria-hidden]"))
      event.target.closest<HTMLElement>('[role="treeitem"]')?.focus();
  };
  return (
    <span class="k2-nt-menu" on:keydown={stop} on:click={stop} on:pointerdown={stop} on:focusin={back}>
      <Menu label={props.label} items={props.items} pointerOnly />
    </span>
  );
};

/** The tree of a `Nav` group: places of 32 px, one level 12 px further in, the arrow before the symbol. */
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
  // the "Weitere laden" entries whose last page failed; they say so and try again on the next press
  const [failedMore, setFailedMore] = createSignal<readonly string[]>([]);
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
        // Whether the person waits on this entry: only then does the focus follow the places that come.
        const entry = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
        const waiting = entry instanceof HTMLElement && entry.matches('[role="treeitem"]') && document.activeElement === entry;
        const stillWaiting = () => {
          const active = document.activeElement;
          return active === entry || active === null || active === document.body;
        };
        setFailedMore(failedMore().filter((other) => other !== key));
        return props.loadMore?.(parent).then(
          () => {
            // the focus goes on to the first place that came, where reading goes on
            const next = childrenOf(parent)[before];
            if (next && waiting) requestAnimationFrame(() => stillWaiting() && parts.controller.focus(next.key));
          },
          () => {
            setFailedMore([...failedMore(), key]);
            announceText(t().loadMoreFailed);
          },
        );
      }
      const node = nodes().get(key);
      // a place without an address folds open and shut on a press; its arrow does that itself
      const onArrow = event?.target instanceof Element && event.target.closest(".k2-nt-chev");
      if (node && node.href === undefined && isBranch(node) && !onArrow) parts.controller.toggle(key);
      return undefined;
    },
  }));
  const dragging = useDragMove(() => props.drag, {
    targets: () => [...nodes().keys()].filter((key) => props.drag?.target?.(key)),
    // a place never goes into a place that lies in it
    within: (target, key) => (treePath(props.items, target) ?? []).includes(key),
    open: (key) => {
      if (!parts.controller.isExpanded(key)) parts.controller.expand(key);
    },
  });
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

  const More = (more: { parent: string | null; count: true | number; position: number; size: number }) => {
    const failed = () => failedMore().includes(moreOf(more.parent));
    return (
      <parts.Item
        value={moreOf(more.parent)}
        label={t().loadMore({ count: undefined })}
        class="k2-nt-item"
        aria-posinset={more.position}
        aria-setsize={more.size}
        ref={(element: HTMLElement) => keepPlace(element, () => ({ position: more.position, size: more.size }))}
        data-failed-more={failed() ? "" : undefined}
      >
        <div class="k2-ni k2-nt-row" data-more="">
          <span class="k2-nt-chev">
            <Icon name="loader-2" />
            <Icon name="alert-circle" />
          </span>
          <parts.Label class="k2-ni-name">
            {failed() ? t().loadMoreFailed : t().loadMore({ count: more.count === true ? undefined : more.count })}
          </parts.Label>
        </div>
      </parts.Item>
    );
  };

  // A level that pages says its whole size (the loaded places and those still to come; -1 while nobody knows it), so
  // its places say it too, and "Weitere laden" stands after the loaded ones.
  // Places are made once per key: new data for the same place (a page that came, a count that changed) updates it in
  // place, so its element and the focus in it stay.
  const level = (list: () => readonly NavTreeNode[], parent: string | null, more: () => true | number | undefined): JSX.Element => {
    const size = () => {
      const count = props.loadMore ? more() : undefined;
      return count === undefined ? undefined : count === true ? -1 : list().length + count;
    };
    const keys = createMemo(() => list().map((node) => node.key));
    return (
      <>
        <For each={keys()}>
          {(key, index) => (
            <Show when={nodes().get(key)}>
              {(node) => <Entry node={node()} position={size() === undefined ? undefined : index() + 1} size={size()} />}
            </Show>
          )}
        </For>
        <Show when={props.loadMore && more()}>
          {(count) => <More parent={parent} count={count()} position={list().length + 1} size={size() ?? list().length + 1} />}
        </Show>
      </>
    );
  };

  /**
   * Core counts the places it has rendered for `aria-posinset` and `aria-setsize`; a level that pages knows more, so
   * its numbers are kept on the element (the server's page has them from the attributes already).
   */
  const keepPlace = (element: HTMLElement, place: () => { position?: number; size?: number }) => {
    const apply = () => {
      const { position, size } = place();
      if (size === undefined) return;
      if (element.getAttribute("aria-setsize") !== String(size)) element.setAttribute("aria-setsize", String(size));
      if (position !== undefined && element.getAttribute("aria-posinset") !== String(position))
        element.setAttribute("aria-posinset", String(position));
    };
    const watch = new MutationObserver(apply);
    watch.observe(element, { attributes: true, attributeFilter: ["aria-setsize", "aria-posinset"] });
    createEffect(apply);
    onCleanup(() => watch.disconnect());
  };

  const Entry = (entry: { node: NavTreeNode; position?: number; size?: number }) => {
    const drag = dragging.entry(entry.node.key);
    return (
      <parts.Item
        value={entry.node.key}
        label={entry.node.label}
        branch={isBranch(entry.node)}
        class="k2-nt-item"
        aria-posinset={entry.position}
        aria-setsize={entry.size}
        // its deeds open from Shift+F10 on the place (the "…" is no Tab stop)
        aria-keyshortcuts={entry.node.menu ? "Shift+F10" : undefined}
        ref={(element: HTMLElement) => keepPlace(element, () => ({ position: entry.position, size: entry.size }))}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.target !== event.currentTarget || !entry.node.menu || !asksForMenu(event)) return;
          event.preventDefault();
          if (event.currentTarget instanceof Element) openMenuOf(event.currentTarget);
        }}
      >
        {(() => {
          const row = (
            <div
              {...drag.attrs}
              ref={drag.ref}
              class="k2-ni k2-nt-row"
              data-k2-part="Nav.Item"
              data-has-menu={entry.node.menu ? "" : undefined}
            >
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
                  // the tree item is what assistive technology meets (named by this text); Enter on it follows the link
                  <parts.Link href={href()} onNavigate={entry.node.onNavigate} class="k2-ni-name" role="none">
                    {entry.node.label}
                  </parts.Link>
                )}
              </Show>
              <Show when={entry.node.dot}>{(status) => <Dot status={status()} />}</Show>
              <Show when={entry.node.count !== undefined}>
                <span class="k2-ni-count">{entry.node.count}</span>
              </Show>
              <Show when={entry.node.menu}>
                {(menu) => <TreeMenu label={overlay().actionsFor({ name: entry.node.label })} items={menu()} />}
              </Show>
            </div>
          );
          // a right-click and a long press on the row open the place's deeds (a phone, also with VoiceOver, has no keys)
          return (
            <Show when={entry.node.menu} fallback={row}>
              {(menu) => <Menu.Context items={menu()}>{row}</Menu.Context>}
            </Show>
          );
        })()}
        <Show when={isBranch(entry.node)}>
          <parts.Group class="k2-nt-group">
            {untrack(() =>
              level(
                () => entry.node.children ?? [],
                entry.node.key,
                () => entry.node.more,
              ),
            )}
          </parts.Group>
        </Show>
      </parts.Item>
    );
  };

  return (
    <>
      <parts.Root
        ref={(element: HTMLElement) => {
          root = element;
        }}
        class="k2-nt"
        data-k2-part="Nav.Tree"
        aria-label={props.label}
      >
        {untrack(() =>
          level(
            () => props.items,
            null,
            () => props.more,
          ),
        )}
      </parts.Root>
      {dragging.zone()}
    </>
  );
};
