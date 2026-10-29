import { For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { IconButton, IconButtonLink } from "../actions/Button";
import ScrollArea from "./ScrollArea";
import { installScrollFades } from "./scroll-fade";
import type { TabBarItem } from "./TabBar";

export type MobileShellProps = {
  /** Usually `MobileShell.Header`; it sits above the scroll area and pads the top safe area. */
  header?: JSX.Element;
  /** Usually a `TabBar`; it sits below the scroll area and pads the bottom safe area itself. */
  footer?: JSX.Element;
  /**
   * Usually `MobileShell.Sidebar` with the footer's destinations and more. From 48rem of window width it stands at
   * the start edge and the footer goes; below, it is not shown. The server renders both, so CSS alone decides.
   */
  sidebar?: JSX.Element;
  /** The page content, inside the shell's only scroll area. */
  children: JSX.Element;
  /**
   * `false` for content that brings its own heads and scroll areas, such as `AppWorkspace.Main` levels: it fills the
   * main area without the shell's scroll area, and the header shows only as the frame of the next page while a tapped
   * tab's page loads.
   */
  scroll?: boolean;
  class?: string;
};

export type MobileShellHeaderProps = {
  title: string;
  /** The title while the shell shows its sidebar, which already names the app; `title` by default. */
  sidebarTitle?: string;
  /**
   * A Back control before the title: a link with `href`, otherwise a button. `withSidebar: false` hides it while the
   * shell shows its sidebar, for a way back to a destination the sidebar lists.
   */
  back?: { href?: string; onClick?: () => void; label: string; withSidebar?: boolean };
  /** Controls after the title, such as a menu. */
  actions?: JSX.Element;
};

/** Read by the toast rail, which is portalled outside the shell, so it lives on the body. */
const FOOTER_HEIGHT = "--k2b-mobile-shell-footer-height";
/** How much of the scroll area a persistent toast covers; local to the shell. */
const TOAST_INSET = "--k2b-mobile-shell-toast-inset";

/**
 * The visible part of the toast rail when it holds a toast without a timer (`duration: 0`, running progress, or a
 * custom slot), so the last row of the scroll area can still scroll above it. A rail that sits elsewhere, such as
 * above a dialog, covers nothing.
 */
const persistentToastInset = (body: HTMLElement): number => {
  if (document.querySelector("dialog:modal")) return 0;
  const cards = [...document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] [data-k2b-toast]:not([data-closing])")];
  if (!cards.some((card) => card.dataset.persistent === "true")) return 0;
  const area = body.getBoundingClientRect();
  const top = Math.min(...cards.map((card) => card.getBoundingClientRect().top));
  return Math.max(0, Math.min(area.height, area.bottom - top));
};

/** Marks the link whose page is loading; the tab bar shows it as selected. */
const PENDING = "data-k2b-pending";
/** On a link: the title of the page it opens. Such a link switches the shell to that page's frame at the first touch. */
const PAGE_TITLE = "data-k2b-title";
/** On the root while the shell shows the frame of the page that is loading. */
const SWITCHING = "data-k2b-switching";
/** On the header title while the shell switches: the loading page's title, which the title shows instead. */
const NEXT_TITLE = "data-k2b-next-title";

/** The link a click or press follows as a page load of this origin, or null when it does something else. */
const pageLink = (root: HTMLElement, event: MouseEvent): HTMLAnchorElement | null => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || !root.contains(link) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return null;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return null;
  // A jump inside the page loads nothing.
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return null;
  return link;
};

/**
 * Taps on the shell's links. iOS shows `:active` only while the page listens to touches, so a tap gets its pressed
 * state at once. A link's page keeps loading while the old page stays visible; a second tap on it would cancel that
 * load and start it over, so it is ignored. A link that names its page's title, such as a tab, shows that page's
 * frame at the first touch instead of at the end of the tap: its title and an empty content area, until the page
 * arrives. Returns the cleanup.
 */
const observeLinkTaps = (root: HTMLElement): (() => void) => {
  /** The link marked as the next page. */
  let pending: string | undefined;
  /** Whether its page is loading; a pressed tab waits for its click. */
  let loading = false;
  const clear = () => {
    pending = undefined;
    loading = false;
    for (const link of root.querySelectorAll(`[${PENDING}]`)) link.removeAttribute(PENDING);
    root.removeAttribute(SWITCHING);
    root.querySelector(".k2b-mobile-shell__title")?.removeAttribute(NEXT_TITLE);
  };
  const mark = (link: HTMLAnchorElement) => {
    clear();
    pending = link.href;
    link.setAttribute(PENDING, "");
    const title = link.getAttribute(PAGE_TITLE);
    const heading = root.querySelector(".k2b-mobile-shell__title");
    if (title === null || !heading) return;
    heading.setAttribute(NEXT_TITLE, title);
    root.setAttribute(SWITCHING, "");
  };
  const touch = () => {};
  // A press on a tab shows its page's frame while the finger is still down. The page itself loads with the click
  // that ends the tap, as for any link: only the end of a touch counts as the person's action, and a load that
  // started before it could let the browser's Back skip this page.
  const press = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const link = pageLink(root, event);
    if (!link?.hasAttribute(PAGE_TITLE) || (link.href === pending && loading)) return;
    mark(link);
  };
  // A press that the browser takes over, such as one that turns into a scroll, ends without a click and takes its
  // frame back.
  const cancel = (event: PointerEvent) => {
    if (event.isPrimary && !loading) clear();
  };
  // On the window, so it runs after every handler of the click, including delegated ones that prevent it.
  const click = (event: MouseEvent) => {
    const link = pageLink(root, event);
    if (link && link.href === pending && loading) {
      event.preventDefault();
      return;
    }
    // Any other tap ends the wait, also for a link that answered with a download instead of a page.
    clear();
    if (!link) return;
    mark(link);
    loading = true;
  };
  // iOS sends no click for a tap on content without an action, so the end of a tap anywhere else ends the wait as
  // well. A touch that scrolls ends without a pointerup and keeps a load's wait.
  const release = (event: PointerEvent) => {
    if (pending === undefined) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (link?.href !== pending) clear();
  };
  // A page restored from the back/forward cache shows the state it was left in.
  const show = (event: PageTransitionEvent) => {
    if (event.persisted) clear();
  };
  document.addEventListener("touchstart", touch, { passive: true });
  window.addEventListener("pointerdown", press);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("pointerup", release);
  window.addEventListener("click", click);
  window.addEventListener("pageshow", show);
  return () => {
    document.removeEventListener("touchstart", touch);
    window.removeEventListener("pointerdown", press);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("click", click);
    window.removeEventListener("pageshow", show);
    clear();
  };
};

/**
 * Keeps a mounted shell working: the footer height on the body, which the portalled toast rail reads, the room a
 * persistent toast takes from the scroll area, the scroll area's edge fade, and immediate feedback for link taps.
 * The fade is the only cue at the footer's edge, which has no rule. `MobileShell` calls it itself;
 * a page that renders the shell on the server without hydrating it calls it once in the browser. Returns the
 * cleanup.
 */
export function observeMobileShell(root: HTMLElement): () => void {
  const main = root.querySelector<HTMLElement>(":scope > .k2b-mobile-shell__main");
  const body = main?.querySelector<HTMLElement>(":scope > .k2b-mobile-shell__body");
  if (!main) return () => {};
  const stopLinkTaps = observeLinkTaps(root);
  // Content with its own scroll areas keeps its own fades; the room a toast takes applies to the whole main area.
  const stopScrollFades = body ? installScrollFades(body) : () => {};
  let frame = 0;
  let owner: HTMLElement | null = null;
  let resize: ResizeObserver | undefined;
  const watchOwner = () => {
    const next = root.querySelector<HTMLElement>("[data-k2b-shell-bottom]");
    if (next === owner) return;
    if (owner) resize?.unobserve(owner);
    owner = next;
    if (owner) resize?.observe(owner);
  };
  const measure = () => {
    frame = 0;
    watchOwner();
    const rootBottom = root.getBoundingClientRect().bottom;
    // Content that owns the bottom edge, such as a chat's composer, counts as the footer, so toasts stay above it.
    const owned = owner?.getClientRects().length ? rootBottom - owner.getBoundingClientRect().top : 0;
    const footer = Math.max(0, rootBottom - main.getBoundingClientRect().bottom, owned);
    document.body.style.setProperty(FOOTER_HEIGHT, `${footer}px`);
    root.style.setProperty(TOAST_INSET, `${persistentToastInset(body ?? main)}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  // The footer can appear, disappear, or change height; the main area takes whatever it leaves. Content that owns the
  // bottom edge, such as a composer, grows and shrinks on its own.
  resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(main);
  measure();
  // Toasts arrive and leave anywhere in the document, and their slots grow and collapse in a transition.
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "data-closing", "data-persistent", "open"],
  });
  document.addEventListener("transitionend", schedule, true);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    document.removeEventListener("transitionend", schedule, true);
    document.body.style.removeProperty(FOOTER_HEIGHT);
    stopLinkTaps();
    stopScrollFades();
  };
}

function MobileShellRoot(props: MobileShellProps): JSX.Element {
  let root!: HTMLDivElement;

  onMount(() => onCleanup(observeMobileShell(root)));

  return (
    <div
      ref={root}
      class={props.class ? `k2b-mobile-shell ${props.class}` : "k2b-mobile-shell"}
      data-k2b-content-heads={props.scroll === false ? "" : undefined}
    >
      {props.sidebar}
      {props.header}
      <main class="k2b-mobile-shell__main">
        <Show when={props.scroll !== false} fallback={props.children}>
          <ScrollArea class="k2b-mobile-shell__body">{props.children}</ScrollArea>
        </Show>
      </main>
      {props.footer}
    </div>
  );
}

function MobileShellHeader(props: MobileShellHeaderProps): JSX.Element {
  return (
    <header class="k2b-mobile-shell__header">
      <Show when={props.back}>
        {(back) => (
          <Show
            when={back().href}
            fallback={
              <IconButton
                class="k2b-mobile-shell__back"
                data-with-sidebar={back().withSidebar === false ? "false" : undefined}
                label={back().label}
                tooltip={false}
                onClick={() => back().onClick?.()}
              >
                <i class="ti ti-chevron-left" aria-hidden="true" />
              </IconButton>
            }
          >
            {(href) => (
              <IconButtonLink
                class="k2b-mobile-shell__back"
                data-with-sidebar={back().withSidebar === false ? "false" : undefined}
                href={href()}
                label={back().label}
                tooltip={false}
                onClick={() => back().onClick?.()}
              >
                <i class="ti ti-chevron-left" aria-hidden="true" />
              </IconButtonLink>
            )}
          </Show>
        )}
      </Show>
      <h1 class="k2b-mobile-shell__title">
        <Show when={props.sidebarTitle !== undefined && props.sidebarTitle !== props.title} fallback={props.title}>
          <span class="k2b-mobile-shell__title-narrow">{props.title}</span>
          <span class="k2b-mobile-shell__title-wide">{props.sidebarTitle}</span>
        </Show>
      </h1>
      <Show when={props.actions}>
        <div class="k2b-mobile-shell__actions">{props.actions}</div>
      </Show>
    </header>
  );
}

export type MobileShellSidebarItem = TabBarItem & {
  /**
   * A quiet count after the label, such as open tasks: a number (0 shows nothing) or an element that renders one. The
   * item's `badge`, which calls for attention, takes its place.
   */
  count?: number | JSX.Element;
};

export type MobileShellSidebarProps = {
  /** Accessible name of the navigation landmark; usually the tab bar's. */
  label: string;
  /** The app's name in the sidebar's head. */
  title: string;
  /** Address of the app's logo before the name; decorative, the name says it. */
  logo?: string;
  /** Destinations at the top, such as Start. */
  items: readonly MobileShellSidebarItem[];
  /** Named groups below them, such as the apps; a group without items is left out. */
  sections?: readonly { title: string; items: readonly MobileShellSidebarItem[] }[];
  /** Destinations at the bottom edge, such as Settings. */
  footer?: readonly MobileShellSidebarItem[];
};

function SidebarLink(props: { item: MobileShellSidebarItem }): JSX.Element {
  return (
    <a
      href={props.item.href}
      aria-current={props.item.current ? "page" : undefined}
      data-tab={props.item.id}
      data-k2b-title={props.item.title ?? props.item.label}
    >
      <i class={props.item.icon} aria-hidden="true" />
      <span class="k2b-truncate-fade">{props.item.label}</span>
      <Show when={props.item.badge ?? props.item.count}>{(mark) => <span class="k2b-mobile-shell__sidebar-count">{mark()}</span>}</Show>
    </a>
  );
}

/**
 * The navigation of a touch app on a wide screen, in `MobileShell`'s `sidebar`: the app's name, then its destinations
 * as 44 px rows with icon and label, the open one in the action colour. A press shows the item's page frame at once,
 * as on a tab, and the row of a loading page pulses.
 */
function MobileShellSidebar(props: MobileShellSidebarProps): JSX.Element {
  const list = (items: readonly MobileShellSidebarItem[]) => (
    <ul>
      <For each={items}>
        {(item) => (
          <li>
            <SidebarLink item={item} />
          </li>
        )}
      </For>
    </ul>
  );
  return (
    <nav class="k2b-mobile-shell__sidebar" aria-label={props.label}>
      <div class="k2b-mobile-shell__sidebar-head">
        <Show when={props.logo}>{(logo) => <img src={logo()} alt="" width="32" height="32" />}</Show>
        <span class="k2b-truncate-fade">{props.title}</span>
      </div>
      <div class="k2b-mobile-shell__sidebar-body">
        {list(props.items)}
        <For each={(props.sections ?? []).filter((section) => section.items.length > 0)}>
          {(section) => (
            <section>
              <h2>{section.title}</h2>
              {list(section.items)}
            </section>
          )}
        </For>
      </div>
      <Show when={props.footer?.length}>
        <div class="k2b-mobile-shell__sidebar-foot">{list(props.footer ?? [])}</div>
      </Show>
    </nav>
  );
}

/**
 * The full-screen frame of a phone app: a header, one scroll area, and an optional footer such as a `TabBar`. With a
 * `sidebar`, a window of 48rem and wider shows the sidebar at the start edge instead of the footer, and the toast rail
 * stays in the area beside it. While it is mounted, the document itself never scrolls, pinch zoom and rubber-banding
 * are off, and the toast rail sits above the footer. Mount one per page, as the page's layout.
 */
export const MobileShell = Object.assign(MobileShellRoot, { Header: MobileShellHeader, Sidebar: MobileShellSidebar });

export default MobileShell;
