/**
 * Opt-in browser navigation helpers for SSR islands.
 *
 * There is no route matching and no client loader. Links remain real anchors:
 * an island decides whether an enhanced click updates client state, and an
 * installed page swap replaces a declared content column with server HTML.
 */
import { type JSX, mergeProps, splitProps } from "solid-js";
import { createDynamic } from "solid-js/web";
import {
  cancelPageSwap,
  captureScroll,
  documentNavigate,
  navigate,
  resolveNavigationUrl,
  restoreScroll,
  startViewTransition,
  swapOvertakes,
} from "./nav-history";

export {
  captureScroll,
  currentPathWithQuery,
  documentNavigate,
  listenPopState,
  navigate,
  navigateTo,
  refreshCurrentPath,
  restoreScroll,
  startViewTransition,
} from "./nav-history";

type AnchorProps = JSX.AnchorHTMLAttributes<HTMLAnchorElement>;

export type NavigationScrollMode = "top" | "preserve" | "manual";

export type ScrollSnapshot = {
  window: { x: number; y: number };
  regions: Array<{
    key: string;
    x: number;
    y: number;
  }>;
};

export type EnhancedNavigateOptions = {
  replace?: boolean;
  scroll?: NavigationScrollMode;
  scrollSnapshot?: ScrollSnapshot;
  state?: unknown;
  viewTransition?: boolean;
};

export type PopStateNavigationEvent = {
  event: PopStateEvent;
  url: URL;
  state: unknown;
};

export type LinkNavigateEvent = {
  event: MouseEvent;
  href: string;
  url: URL;
  replace: boolean;
  scroll: NavigationScrollMode;
  push: (href?: string, options?: EnhancedNavigateOptions) => void;
  replaceWith: (href?: string, options?: Omit<EnhancedNavigateOptions, "replace">) => void;
  fallback: (href?: string) => void;
  scrollSnapshot: ScrollSnapshot;
  captureScroll: (selector?: string) => ScrollSnapshot;
  restoreScroll: typeof restoreScroll;
};

export type LinkProps = Omit<AnchorProps, "href" | "onClick"> & {
  href: string;
  /** Default history mode for enhanced clicks. Ignored without `onNavigate`. */
  replace?: boolean;
  /** Default scroll mode for enhanced clicks. Ignored without `onNavigate`. */
  scroll?: NavigationScrollMode;
  onClick?: JSX.EventHandlerUnion<HTMLAnchorElement, MouseEvent>;
  /** Enables enhanced same-origin clicks. Without it, `Link` is a native anchor. */
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
};

const shouldEnhanceClick = (event: MouseEvent, anchor: HTMLAnchorElement): boolean => {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;

  const url = new URL(anchor.href);
  return url.origin === window.location.origin;
};

const callUserClick = (handler: LinkProps["onClick"], event: MouseEvent, anchor: HTMLAnchorElement): void => {
  if (!handler) return;
  const typedEvent = event as MouseEvent & { currentTarget: HTMLAnchorElement; target: Element };

  if (Array.isArray(handler)) {
    handler[0].call(anchor, handler[1], typedEvent);
    return;
  }

  if (typeof handler === "function") {
    handler.call(anchor, typedEvent);
  }
};

/**
 * SSR-safe anchor with opt-in progressive navigation.
 */
export function Link(props: LinkProps) {
  const [local, anchorProps] = splitProps(props, ["href", "replace", "scroll", "onNavigate", "onClick"]);

  const handleClick: JSX.EventHandler<HTMLAnchorElement, MouseEvent> = (event) => {
    callUserClick(local.onClick, event, event.currentTarget);
    const onNavigate = local.onNavigate;
    if (!onNavigate) return;
    if (!shouldEnhanceClick(event, event.currentTarget)) return;

    const href = local.href;
    const url = new URL(event.currentTarget.href);

    const scroll = local.scroll ?? "top";
    const replace = Boolean(local.replace);
    const scrollSnapshot = captureScroll();

    event.preventDefault();
    // The island owns this navigation now; a pending page swap must not commit while onNavigate loads.
    cancelPageSwap();
    // A page swap started while onNavigate loads is the newer navigation: this handler no longer moves history.
    const overtaken = swapOvertakes();

    let navigationOutcome: "none" | "history" | "document" = "none";
    const runNavigation = async () => {
      try {
        await onNavigate({
          event,
          href,
          url,
          replace,
          scroll,
          push: (nextHref = url.href, options = {}) => {
            if (overtaken()) return;
            navigate(nextHref, {
              ...options,
              replace: false,
              scroll: options.scroll ?? scroll,
              scrollSnapshot: options.scrollSnapshot ?? scrollSnapshot,
              viewTransition: false,
            });
            navigationOutcome = "history";
          },
          replaceWith: (nextHref = url.href, options = {}) => {
            if (overtaken()) return;
            navigate(nextHref, {
              ...options,
              replace: true,
              scroll: options.scroll ?? scroll,
              scrollSnapshot: options.scrollSnapshot ?? scrollSnapshot,
              viewTransition: false,
            });
            navigationOutcome = "history";
          },
          fallback: (nextHref = url.href) => {
            if (overtaken()) return;
            documentNavigate(resolveNavigationUrl(nextHref).href, { replace });
            navigationOutcome = "document";
          },
          scrollSnapshot,
          captureScroll,
          restoreScroll,
        });
      } catch (error) {
        console.error("[@k2b/ssr/nav] onNavigate failed; falling back to document navigation.", error);
        if (navigationOutcome === "document" || overtaken()) return;
        const historyCommitted = navigationOutcome === "history";
        const fallbackHref = historyCommitted ? window.location.href : url.href;
        documentNavigate(fallbackHref, { replace: historyCommitted || replace });
      }
    };

    startViewTransition(runNavigation);
  };

  return createDynamic(
    () => "a",
    mergeProps(anchorProps, {
      get href() {
        return local.href;
      },
      onClick: handleClick,
    }),
  );
}

export { installPageSwap, swapPage } from "./nav-swap";
