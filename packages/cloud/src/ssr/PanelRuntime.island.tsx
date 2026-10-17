import { installInputModeController, keyboardPlatform } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { syncTimezoneCookie } from "./timezone-cookie";

export default function PanelRuntime(props: { provider?: string }) {
  onMount(() => {
    syncTimezoneCookie(true);
    const disposeInput = installInputModeController();
    const deferred = new Set<ReturnType<typeof setTimeout>>();
    const embedded = window.parent !== window;
    const close = () => window.parent.postMessage({ type: "cloud.panel.close" }, location.origin);
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.altKey || event.shiftKey) return;
      const apple = keyboardPlatform() === "apple";
      if (event.key.toLowerCase() === "j" && event.metaKey === apple && event.ctrlKey === !apple) {
        event.preventDefault();
        if (!event.repeat) close();
      } else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey) {
        const timer = setTimeout(() => {
          deferred.delete(timer);
          if (!event.defaultPrevented) close();
        }, 0);
        deferred.add(timer);
      }
    };
    if (embedded) {
      // The shell reads this mark when its controller arrives after the message.
      if (props.provider) document.documentElement.dataset.cloudPanelReady = props.provider;
      window.parent.postMessage({ type: "cloud.panel.ready", v: 1, provider: props.provider }, location.origin);
      window.addEventListener("keydown", key);
    }
    onCleanup(() => {
      disposeInput();
      window.removeEventListener("keydown", key);
      for (const timer of deferred) clearTimeout(timer);
    });
  });
  return null;
}
