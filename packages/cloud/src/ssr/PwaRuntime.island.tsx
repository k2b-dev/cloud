import { observeMobileShell, syncThemeColor, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { pwaMessages } from "./pwa-messages";
import { type PwaRuntimeProps, startPwaRuntime, THEME_PREFERENCE_EVENT } from "./pwa-runtime";

export type { PwaRuntimeProps } from "./pwa-runtime";

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

    let offlineToast: ToastHandle | undefined;
    let updateToast: ToastHandle | undefined;
    cleanups.push(
      startPwaRuntime(props, {
        offline: (offline) => {
          if (offline) offlineToast ??= toast(t().offline, { duration: 0, iconClass: "ti ti-wifi-off" });
          else {
            offlineToast?.dismiss();
            offlineToast = undefined;
          }
        },
        otherAccount: (name) => toast(t().otherAccount({ cloud: props.cloud, name }), { duration: 0, variant: "warning" }),
        newVersion: () => {
          updateToast ??= toast(t().newVersion({ cloud: props.cloud }), {
            duration: 0,
            iconClass: "ti ti-refresh",
            action: { label: t().reload, onClick: () => location.reload() },
          });
        },
        clear: () => updateToast?.dismiss(),
      }),
    );

    const syncTheme = () => syncThemeColor();
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    cleanups.push(() => window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme));
  });

  return null;
}
