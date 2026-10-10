import { i18n } from "@k2b/stdlib";
import { type ToastHandle, toast } from "@k2b/ui";

/**
 * Default window in which a second automatic reload for the same key is
 * suppressed. A page load, hydration, and the first live subscription finish
 * within a few seconds, so a condition that fails again right after a reload
 * lands well inside it; a genuinely new change minutes later still reloads.
 */
export const AUTOMATIC_RELOAD_WINDOW_MS = 30_000;

const storageKey = (key: string) => `cloud.reload.${key}`;

/**
 * Reloads the page for an automatic reason (a live event, a failed live
 * subscription, a changed view) at most once per `key` and window in this tab.
 *
 * Returns `false` without reloading when the same key already reloaded within
 * the window, or when `sessionStorage` is unavailable and a repeat therefore
 * cannot be ruled out. The caller then keeps the page usable and offers a
 * user-initiated reload instead. Reloads after an explicit user action do not
 * need this guard.
 */
export const reloadOnce = (key: string, options: { windowMs?: number } = {}): boolean => {
  const windowMs = options.windowMs ?? AUTOMATIC_RELOAD_WINDOW_MS;
  const now = Date.now();
  try {
    const storage = window.sessionStorage;
    const last = Number(storage.getItem(storageKey(key)));
    if (last > 0 && now >= last && now - last < windowMs) return false;
    storage.setItem(storageKey(key), String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
};

const reloadMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      codeUnavailable: "Part of this page could not load. Reload the page and try again.",
      reload: "Reload",
    },
    de: {
      codeUnavailable: "Ein Teil dieser Seite konnte nicht geladen werden. Lade die Seite neu und versuche es erneut.",
      reload: "Neu laden",
    },
  },
});

/** One notice at a time: every failed load in the tab has the same remedy. */
let codeUnavailable: ToastHandle | undefined;

/**
 * Loads code that one action needs when the action runs, for example
 * `importOnDemand(() => import("./SettingsDialog"))`, so the page does not
 * download it up front.
 *
 * Resolves `undefined` when the code cannot load. A release replaces the
 * page's code files, so a page that was open before it cannot load code it
 * has not loaded yet; a dropped connection fails the same way. The helper
 * then shows a toast that offers a reload, and the caller only ends its
 * action.
 */
export const importOnDemand = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await load();
  } catch (error) {
    console.warn("[cloud] Could not load code on demand", error);
    const t = reloadMessages.resolve([document.documentElement.lang || "en"]).t;
    codeUnavailable?.dismiss();
    codeUnavailable = toast.error(t.codeUnavailable, {
      duration: 0,
      action: { label: t.reload, onClick: () => window.location.reload() },
    });
    return undefined;
  }
};
