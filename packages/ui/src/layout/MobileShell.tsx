import { type JSX, onCleanup, onMount, Show } from "solid-js";
import { IconButton, IconButtonLink } from "../actions/Button";
import ScrollArea from "./ScrollArea";
import { installScrollFades } from "./scroll-fade";

export type MobileShellProps = {
  /** Usually `MobileShell.Header`; it sits above the scroll area and pads the top safe area. */
  header: JSX.Element;
  /** Usually a `TabBar`; it sits below the scroll area and pads the bottom safe area itself. */
  footer?: JSX.Element;
  /** The page content, inside the shell's only scroll area. */
  children: JSX.Element;
  class?: string;
};

export type MobileShellHeaderProps = {
  title: string;
  /** A Back control before the title: a link with `href`, otherwise a button. */
  back?: { href?: string; onClick?: () => void; label: string };
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

/** The link a click follows as a page load of this origin, or null when the click does something else. */
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
 * load and start it over, so it is ignored. Returns the cleanup.
 */
const observeLinkTaps = (root: HTMLElement): (() => void) => {
  let pending: string | undefined;
  const clear = () => {
    pending = undefined;
    for (const link of root.querySelectorAll(`[${PENDING}]`)) link.removeAttribute(PENDING);
  };
  const touch = () => {};
  // On the window, so it runs after every handler of the click, including delegated ones that prevent it.
  const click = (event: MouseEvent) => {
    const link = pageLink(root, event);
    if (link && link.href === pending) {
      event.preventDefault();
      return;
    }
    // Any other tap ends the wait, also for a link that answered with a download instead of a page.
    clear();
    if (!link) return;
    pending = link.href;
    link.setAttribute(PENDING, "");
  };
  // iOS sends no click for a tap on content without an action, so the end of a tap anywhere else ends the wait as
  // well. A touch that scrolls ends without a pointerup and keeps it.
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
  window.addEventListener("pointerup", release);
  window.addEventListener("click", click);
  window.addEventListener("pageshow", show);
  return () => {
    document.removeEventListener("touchstart", touch);
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
  if (!main || !body) return () => {};
  const stopLinkTaps = observeLinkTaps(root);
  const stopScrollFades = installScrollFades(body);
  let frame = 0;
  const measure = () => {
    frame = 0;
    const footer = Math.max(0, root.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom);
    document.body.style.setProperty(FOOTER_HEIGHT, `${footer}px`);
    root.style.setProperty(TOAST_INSET, `${persistentToastInset(body)}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  measure();
  // The footer can appear, disappear, or change height; the main area takes whatever it leaves.
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(main);
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
    <div ref={root} class={props.class ? `k2b-mobile-shell ${props.class}` : "k2b-mobile-shell"}>
      {props.header}
      <main class="k2b-mobile-shell__main">
        <ScrollArea class="k2b-mobile-shell__body">{props.children}</ScrollArea>
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
              <IconButton class="k2b-mobile-shell__back" label={back().label} tooltip={false} onClick={() => back().onClick?.()}>
                <i class="ti ti-chevron-left" aria-hidden="true" />
              </IconButton>
            }
          >
            {(href) => (
              <IconButtonLink
                class="k2b-mobile-shell__back"
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
      <h1 class="k2b-mobile-shell__title">{props.title}</h1>
      <Show when={props.actions}>
        <div class="k2b-mobile-shell__actions">{props.actions}</div>
      </Show>
    </header>
  );
}

/**
 * The full-screen frame of a phone app: a header, one scroll area, and an optional footer such as a `TabBar`. While
 * it is mounted, the document itself never scrolls, pinch zoom and rubber-banding are off, and the toast rail sits
 * above the footer. Mount one per page, as the page's layout.
 */
export const MobileShell = Object.assign(MobileShellRoot, { Header: MobileShellHeader });

export default MobileShell;
