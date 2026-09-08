type NavigationClick = Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">;
type NavigationAnchor = Pick<HTMLAnchorElement, "href" | "target" | "hasAttribute">;

// The workspace sidebar is rendered outside the builder island. Its ordinary
// document links must wait for this island's draft before replacing the page.
export const createCustomAppNavigationGuard = (options: {
  currentUrl: () => string;
  dirty: () => boolean;
  flush: () => Promise<boolean>;
  navigate: (href: string) => void;
}) => {
  let leaving = false;
  let disposed = false;
  return {
    async click(event: NavigationClick, anchor: NavigationAnchor | null) {
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const current = new URL(options.currentUrl());
      const target = new URL(anchor.href, current);
      if (target.origin !== current.origin) return;
      if (target.hash && target.pathname === current.pathname && target.search === current.search) return;
      if (!options.dirty() && !leaving) return;
      event.preventDefault();
      if (leaving || disposed) return;
      leaving = true;
      try {
        if ((await options.flush()) && !disposed && !options.dirty()) options.navigate(target.href);
      } finally {
        leaving = false;
      }
    },
    beforeUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">) {
      if (!options.dirty()) return;
      event.preventDefault();
      event.returnValue = "";
    },
    dispose() {
      disposed = true;
    },
  };
};
