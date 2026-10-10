import { observeMobileShell, syncThemeColor, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { renewAppSession } from "../browser/app-session";
import { PWA_SCOPE, PWA_SERVICE_WORKER_PATH } from "../contracts/pwa-paths";
import { pwaMessages } from "./pwa-messages";

/** Set once per browsing session, so the first page renews and later navigations do not. */
const RENEWED_MARKER = "cloud.pwa.renewed";
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
/** Matches `cloud:theme-preference` in the preference controller. */
const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

export type PwaRuntimeProps = {
  /** A person uses the app: keep the app session alive. */
  keepalive: boolean;
  /** The installation name, for the account notice. */
  cloud: string;
};

const firstPageOfSession = (): boolean => {
  try {
    if (window.sessionStorage.getItem(RENEWED_MARKER)) return false;
    window.sessionStorage.setItem(RENEWED_MARKER, "1");
  } catch {}
  return true;
};

/**
 * The browser side of every mobile app page: the service worker, the offline notice, the app session keepalive,
 * the status bar colour after a theme change, and the server-rendered shell's measurements.
 */
export default function PwaRuntime(props: PwaRuntimeProps) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;

  onMount(() => {
    const cleanups: (() => void)[] = [];
    onCleanup(() => {
      for (const cleanup of cleanups) cleanup();
    });

    const shell = document.querySelector<HTMLElement>(".k2b-mobile-shell");
    if (shell) cleanups.push(observeMobileShell(shell));

    // The launch bounce marks its return; the page is here now, so the marker leaves the address.
    const url = new URL(location.href);
    if (url.searchParams.has("pwa_launch")) {
      url.searchParams.delete("pwa_launch");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }

    // Registration fails in private windows and insecure contexts; the app then simply works online only.
    void navigator.serviceWorker?.register(PWA_SERVICE_WORKER_PATH, { scope: PWA_SCOPE, updateViaCache: "none" }).catch(() => undefined);

    let offlineToast: ToastHandle | undefined;
    const offline = () => {
      offlineToast ??= toast(t().offline, { duration: 0, iconClass: "ti ti-wifi-off" });
    };
    const online = () => {
      offlineToast?.dismiss();
      offlineToast = undefined;
    };
    if (!navigator.onLine) offline();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    cleanups.push(() => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      offlineToast?.dismiss();
    });

    const syncTheme = () => syncThemeColor();
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    cleanups.push(() => window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme));

    if (!props.keepalive) return;

    let otherAccountShown = false;
    let disposed = false;
    cleanups.push(() => {
      disposed = true;
    });
    const renew = async () => {
      const { otherAccount } = await renewAppSession();
      if (disposed || !otherAccount || otherAccountShown) return;
      otherAccountShown = true;
      toast(t().otherAccount({ cloud: props.cloud, name: otherAccount.name }), { duration: 0, iconClass: "ti ti-alert-triangle" });
    };

    if (firstPageOfSession()) void renew();
    const visible = () => {
      if (document.visibilityState === "visible") void renew();
    };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void renew();
    }, KEEPALIVE_INTERVAL_MS);
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    });
  });

  return null;
}
