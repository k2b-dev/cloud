import { onCleanup, onMount } from "solid-js";

/** Coalesce a return to the app and network into one canonical read, without polling. */
export function refreshOnReturn(refresh: () => void) {
  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(refresh, 100);
    };
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("online", schedule);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("online", schedule);
    });
  });
}
