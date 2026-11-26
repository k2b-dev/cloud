import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { Row } from "./content";
import { linkOr } from "./link";
import { Icon } from "./marks";
import { Dialog } from "./overlays";
import type { OnNavigate } from "./types";

// ── Unread ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A count that calls for attention, such as unread messages (internal; `Nav` and `TabBar` show it): a filled round
 * figure in the app's colour, "99+" above 99, and for assistive technology the words, "3 unread", once. Nothing at 0.
 */
export const Unread = (props: { count: number | undefined }) => {
  const t = useUiMessages();
  const count = () => Math.max(0, Math.floor(props.count ?? 0));
  return (
    <Show when={count() > 0}>
      <span class="k2-unread" data-k2-part="Unread" aria-hidden="true">
        {count() > 99 ? "99+" : count()}
      </span>
      <span class="k2-vh">{count() > 99 ? t().unreadMany : t().unread({ count: count() })}</span>
    </Show>
  );
};

// ── TabBar ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type TabBarItem = {
  /** The words under the symbol, such as "Chat". */
  label: string;
  /** A Tabler icon. */
  icon: string;
  /** The page the tab leads to. */
  href: string;
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  /** The open place. */
  current?: boolean;
  /** A count that calls for attention, such as unread messages; nothing at 0. */
  unread?: number;
};

export type TabBarProps = {
  /** The name of the bar for assistive technology, such as "App". */
  label: string;
  /**
   * Every place of the app, in order. Up to five stand in the bar; with more, the first four stand there and a fifth
   * tab, "More", opens a sheet with the others and their counts.
   */
  items: readonly TabBarItem[];
};

/** Tabs in the bar before "More" takes the fifth place. */
const TAB_SLOTS = 5;

const TabLink = (props: { item: TabBarItem }) => (
  <Dynamic
    component={linkOr(props.item.href, "a")}
    href={props.item.href}
    onNavigate={props.item.onNavigate}
    class="k2-tab"
    data-k2-part="TabBar.Tab"
    aria-current={props.item.current ? "page" : undefined}
  >
    <Icon name={props.item.icon} />
    <span class="k2-tab-label">{props.item.label}</span>
    <Unread count={props.item.unread} />
  </Dynamic>
);

/**
 * The navigation of an app on the phone, at the bottom edge: a symbol and its words per place, the open one in the
 * app's colour, a count that calls for attention as a filled figure on its symbol. It takes the bottom safe area into
 * its own height. With more than five places, "More" opens a sheet with the others. From 768 px it leaves, and the
 * app's `Nav` takes its place. Its height is `--k2-tabbar-h` on the document, so floating parts such as
 * `NoticeStack` stand above it.
 */
export const TabBar = (props: TabBarProps) => {
  const t = useUiMessages();
  const shown = () => (props.items.length <= TAB_SLOTS ? props.items : props.items.slice(0, TAB_SLOTS - 1));
  const rest = () => (props.items.length <= TAB_SLOTS ? [] : props.items.slice(TAB_SLOTS - 1));
  const restUnread = () => rest().reduce((sum, item) => sum + Math.max(0, item.unread ?? 0), 0);
  const [open, setOpen] = createSignal(false);
  let bar: HTMLElement | undefined;
  onMount(() => {
    if (!bar || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const sizes = new ResizeObserver(() => root.style.setProperty("--k2-tabbar-h", `${bar?.offsetHeight ?? 0}px`));
    sizes.observe(bar);
    onCleanup(() => {
      sizes.disconnect();
      root.style.removeProperty("--k2-tabbar-h");
    });
  });
  return (
    <nav ref={bar} class="k2-tabbar" data-k2-part="TabBar" aria-label={props.label}>
      <For each={shown()}>{(item) => <TabLink item={item} />}</For>
      <Show when={rest().length > 0}>
        <button
          type="button"
          class="k2-tab"
          data-k2-part="TabBar.More"
          data-current={rest().some((item) => item.current) ? "" : undefined}
          aria-haspopup="dialog"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen(true)}
        >
          <Icon name="dots" />
          <span class="k2-tab-label">{t().more}</span>
          <Unread count={restUnread()} />
        </button>
        <Dialog title={t().more} open={open()} onOpenChange={setOpen}>
          <For each={rest()}>
            {(item) => (
              <Row
                icon={item.icon}
                lines={[item.label]}
                href={item.href}
                // a place that opens in place closes the sheet first; a page load leaves it anyway
                onNavigate={(() => {
                  const navigate = item.onNavigate;
                  return navigate
                    ? (event: Parameters<OnNavigate>[0]) => {
                        setOpen(false);
                        return navigate(event);
                      }
                    : undefined;
                })()}
                current={item.current}
                end={<Unread count={item.unread} />}
              />
            )}
          </For>
        </Dialog>
      </Show>
    </nav>
  );
};

// ── NoticeStack ──────────────────────────────────────────────────────────────────────────────────────────────────

export type NoticeStackProps = {
  /** `Notice`s that stay until their state ends or the person hides them, such as "Offline" or a new version. */
  children: JSX.Element;
};

/**
 * Notices that float over the page at the bottom, above a `TabBar` and the bottom safe area, and stay until their state
 * ends: offline, a new version. They float, so nothing on the page moves when one comes or goes; the page's panes keep
 * the stack's height free at their end (`--k2-notice-stack` on the document), so the last row stays reachable. On the
 * phone each deed is a framed button of at least 44 px in the end column. Give every notice a way to hide it.
 */
export const NoticeStack = (props: NoticeStackProps) => {
  let stack: HTMLDivElement | undefined;
  onMount(() => {
    if (!stack || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const bar = document.querySelector<HTMLElement>(".k2-tabbar");
    // The room is what the stack covers of the window above the tab bar: from its top to the window's end, less the
    // bar. A pane ends at the bar on the phone and near the window's end beside it, so the last row stays reachable.
    const measure = () => {
      const empty = !stack || stack.offsetHeight === 0;
      const covered = empty ? 0 : innerHeight - stack!.getBoundingClientRect().top - (bar?.offsetHeight ?? 0);
      root.style.setProperty("--k2-notice-stack", `${Math.max(0, Math.ceil(covered))}px`);
    };
    // the stack grows and shrinks with its notices, and moves with the bar (a screen of its own hides it) and the window
    const sizes = new ResizeObserver(measure);
    sizes.observe(stack);
    if (bar) sizes.observe(bar);
    addEventListener("resize", measure);
    measure();
    onCleanup(() => {
      sizes.disconnect();
      removeEventListener("resize", measure);
      root.style.removeProperty("--k2-notice-stack");
    });
  });
  return (
    <div ref={stack} class="k2-notice-stack" data-k2-part="NoticeStack" aria-live="polite">
      {props.children}
    </div>
  );
};
