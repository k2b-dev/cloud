import { dates } from "@k2b/stdlib";
import { createSignal, onCleanup, onMount } from "solid-js";

/** One calendar clock per block, shared by every relative-date cell in that block. */
export const createCalendarDateBase = (initialBase: string, timeZone?: string) => {
  const [base, setBase] = createSignal(initialBase);
  onMount(() => {
    const refresh = () => {
      const now = new Date().toISOString();
      if (dates.formatDateKey(now, { timeZone }) !== dates.formatDateKey(base(), { timeZone })) setBase(now);
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    const visible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    });
  });
  return base;
};
