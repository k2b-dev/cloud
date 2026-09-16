import type { CloudResourceRef } from "../contracts";

export type SearchScope = { label: string; icon?: string } & ({ ref: CloudResourceRef; appId?: never } | { appId: string; ref?: never });
export type GlobalSearchOptions = { scope?: SearchScope };
export type SearchNavigationTarget = { href: string; ref?: CloudResourceRef };
type OpenRequest = { options: GlobalSearchOptions; accepted: boolean };
type NavigationRequest = { target: SearchNavigationTarget; handled?: Promise<boolean> };

declare global {
  interface WindowEventMap {
    "cloud.search.open": CustomEvent<OpenRequest>;
    "cloud.search.navigate": CustomEvent<NavigationRequest>;
  }
}

const READY = "cloud.search.ready";
const CANCEL_OPEN = "cloud.search.cancel-open";
const REPLACE_HOST = "cloud.search.replace-host";
const REPLACE_NAVIGATION = "cloud.search.replace-navigation";

/** One pending request per document, shared through events even across separate bundles. */
export const requestGlobalSearch = (options: GlobalSearchOptions): Promise<void> => {
  window.dispatchEvent(new Event(CANCEL_OPEN));
  return new Promise((resolve, reject) => {
    const detail: OpenRequest = { options, accepted: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(READY, attempt);
      window.removeEventListener(CANCEL_OPEN, cancel);
      window.removeEventListener("pagehide", cancel);
    };
    const cancel = () => {
      cleanup();
      resolve();
    };
    const attempt = () => {
      window.dispatchEvent(new CustomEvent("cloud.search.open", { detail }));
      if (detail.accepted) cancel();
    };
    window.addEventListener(READY, attempt);
    window.addEventListener(CANCEL_OPEN, cancel);
    window.addEventListener("pagehide", cancel);
    // Bound the wait for hydration; never keep an invisible request indefinitely.
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Search host unavailable"));
    }, 8_000);
    attempt();
  });
};

export const registerGlobalSearchHost = (open: (options: GlobalSearchOptions) => void, dispose?: () => void): (() => void) => {
  window.dispatchEvent(new Event(REPLACE_HOST));
  const listener = (event: CustomEvent<OpenRequest>) => {
    if (event.detail.accepted) return;
    open(event.detail.options);
    event.detail.accepted = true;
  };
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    dispose?.();
    window.removeEventListener("cloud.search.open", listener);
    window.removeEventListener(REPLACE_HOST, cleanup);
  };
  window.addEventListener("cloud.search.open", listener);
  window.addEventListener(REPLACE_HOST, cleanup);
  window.dispatchEvent(new Event(READY));
  return cleanup;
};

export const registerSearchNavigation = (handler: (target: SearchNavigationTarget) => boolean | Promise<boolean>): (() => void) => {
  window.dispatchEvent(new Event(REPLACE_NAVIGATION));
  let active = true;
  const listener = (event: CustomEvent<NavigationRequest>) => {
    if (event.detail.handled) return;
    event.detail.handled = Promise.resolve().then(async () => {
      if (!active) return true; // An unmounted page must not start a late navigation.
      const handled = await handler(event.detail.target);
      return !active || handled;
    });
  };
  const cleanup = () => {
    active = false;
    window.removeEventListener("cloud.search.navigate", listener);
    window.removeEventListener(REPLACE_NAVIGATION, cleanup);
  };
  window.addEventListener("cloud.search.navigate", listener);
  window.addEventListener(REPLACE_NAVIGATION, cleanup);
  return cleanup;
};

export const requestSearchNavigation = async (target: SearchNavigationTarget): Promise<boolean> => {
  const detail: NavigationRequest = { target };
  window.dispatchEvent(new CustomEvent("cloud.search.navigate", { detail }));
  return (await detail.handled) ?? false;
};
