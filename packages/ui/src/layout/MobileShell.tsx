import { type JSX, onCleanup, onMount, Show } from "solid-js";
import { IconButton, IconButtonLink } from "../actions/Button";
import ScrollArea from "./ScrollArea";

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
 * The visible part of the toast rail when it holds a toast that stays until it is closed, so the last row of the
 * scroll area can still scroll above it. A rail that sits elsewhere, such as above a dialog, covers nothing.
 */
const persistentToastInset = (body: HTMLElement): number => {
  if (document.querySelector("dialog:modal")) return 0;
  const cards = [...document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] [data-k2b-toast]:not([data-closing])")];
  if (!cards.some((card) => card.dataset.persistent === "true")) return 0;
  const area = body.getBoundingClientRect();
  const top = Math.min(...cards.map((card) => card.getBoundingClientRect().top));
  return Math.max(0, Math.min(area.height, area.bottom - top));
};

function MobileShellRoot(props: MobileShellProps): JSX.Element {
  let root!: HTMLDivElement;
  let main!: HTMLElement;
  let body!: HTMLDivElement;

  onMount(() => {
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
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.removeEventListener("transitionend", schedule, true);
      document.body.style.removeProperty(FOOTER_HEIGHT);
    });
  });

  return (
    <div ref={root} class={props.class ? `k2b-mobile-shell ${props.class}` : "k2b-mobile-shell"}>
      {props.header}
      <main ref={main} class="k2b-mobile-shell__main">
        <ScrollArea ref={body} class="k2b-mobile-shell__body">
          {props.children}
        </ScrollArea>
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
