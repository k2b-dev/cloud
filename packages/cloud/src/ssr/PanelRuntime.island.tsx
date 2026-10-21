import { installAppWorkspaceController, installInputModeController, keyboardPlatform } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { installPanelContextReceiver } from "../browser/panel-context-receiver";
import { hasPanelLeaveGuard, panelLinkDestination } from "../browser/panel-leave";
import { syncTimezoneCookie } from "./timezone-cookie";

export default function PanelRuntime(props: { provider?: string; scope?: string }) {
  onMount(() => {
    syncTimezoneCookie(true);
    const disposeInput = installInputModeController();
    // The SSR body hands workspace controller ownership to the page runtime, as Layout's ShellRuntime does. A panel
    // page keeps no workspace layout cookie: the app's own layout must not follow the reader into a narrow panel.
    const disposeWorkspace = installAppWorkspaceController();
    const deferred = new Set<ReturnType<typeof setTimeout>>();
    const embedded = window.parent !== window;
    let disposeTheme = () => {};
    let disposeContext = () => {};
    let resumeTheme = () => {};
    // A page kept in the back/forward cache keeps following the host; only a removed iframe lets go.
    const pageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) disposeTheme();
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resumeTheme();
    };
    const close = () => window.parent.postMessage({ type: "cloud.panel.close" }, location.origin);
    const click = (event: MouseEvent) => {
      const url = panelLinkDestination(event);
      if (!url) return;
      const scope = props.scope?.replace(/\/$/, "");
      const internal = scope !== undefined && (url.pathname === scope || url.pathname.startsWith(`${scope}/`));
      if (!hasPanelLeaveGuard()) {
        if (internal) return;
        event.preventDefault();
        window.parent.location.assign(url.href);
        return;
      }
      event.preventDefault();
      window.parent.postMessage({ type: "cloud.panel.navigate", v: 1, href: url.href }, location.origin);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.altKey || event.shiftKey) return;
      const apple = keyboardPlatform() === "apple";
      if (event.key.toLowerCase() === "j" && event.metaKey === apple && event.ctrlKey === !apple) {
        event.preventDefault();
        if (!event.repeat) close();
      } else if (event.key.toLowerCase() === "k" && event.metaKey === apple && event.ctrlKey === !apple) {
        event.preventDefault();
        if (!event.repeat) window.parent.postMessage({ type: "cloud.panel.search", v: 1 }, location.origin);
      } else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey) {
        // An open modal dialog takes Escape through its cancel event, without preventing this keydown.
        if (document.querySelector("dialog[open], [aria-modal='true']")) return;
        const timer = setTimeout(() => {
          deferred.delete(timer);
          if (!event.defaultPrevented) close();
        }, 0);
        deferred.add(timer);
      }
    };
    if (embedded) {
      disposeContext = installPanelContextReceiver();
      try {
        const parent = window.parent;
        const parentRoot = parent.document.documentElement;
        const syncTheme = () => {
          for (const theme of ["light", "dark"]) {
            document.documentElement.classList.toggle(theme, parentRoot.classList.contains(theme));
          }
        };
        parent.addEventListener("cloud:theme-preference", syncTheme);
        disposeTheme = () => parent.removeEventListener("cloud:theme-preference", syncTheme);
        resumeTheme = syncTheme;
        syncTheme();
      } catch {
        // A cross-origin parent cannot share its document or theme events.
      }
      window.addEventListener("pagehide", pageHide);
      window.addEventListener("pageshow", pageShow);
      // The shell reads this mark when its controller arrives after the message.
      if (props.provider) document.documentElement.dataset.cloudPanelReady = props.provider;
      window.parent.postMessage({ type: "cloud.panel.ready", v: 1, provider: props.provider }, location.origin);
      window.addEventListener("keydown", key);
      window.addEventListener("click", click);
    }
    onCleanup(() => {
      disposeContext();
      disposeInput();
      disposeWorkspace();
      disposeTheme();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("keydown", key);
      window.removeEventListener("click", click);
      for (const timer of deferred) clearTimeout(timer);
    });
  });
  return null;
}
