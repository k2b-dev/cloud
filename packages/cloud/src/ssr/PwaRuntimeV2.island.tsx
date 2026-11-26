import { syncThemeColor, useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { pwaMessages } from "./pwa-messages";
import { type PwaRuntimeProps, startPwaRuntime, THEME_PREFERENCE_EVENT } from "./pwa-runtime";

/**
 * The browser side of a v2 mobile app page (`PwaLayout ui="v2"`): the runtime of every app page, and what it finds
 * as v2 notices that float above the tab bar and stay until their state ends: offline, Chrome signed in to another
 * account, a new version with "Reload". They float, so nothing on the page moves when one comes or goes.
 */
export default function PwaRuntimeV2(props: PwaRuntimeProps) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;
  const [offline, setOffline] = createSignal(false);
  const [otherAccount, setOtherAccount] = createSignal<string>();
  const [newVersion, setNewVersion] = createSignal(false);

  onMount(() => {
    const stop = startPwaRuntime(props, {
      offline: setOffline,
      otherAccount: setOtherAccount,
      newVersion: () => setNewVersion(true),
      clear: () => {
        setOtherAccount(undefined);
        setNewVersion(false);
      },
    });
    // The status bar takes the frame's canvas, as the page's head gave it.
    const syncTheme = () => syncThemeColor(document.querySelector(".pwa-v2") ?? undefined);
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    onCleanup(() => {
      stop();
      window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    });
  });

  return (
    <div class="pwa-v2-notices" aria-live="polite">
      <Show when={offline()}>
        <Notice tone="warn" icon="wifi-off">
          {t().offline}
        </Notice>
      </Show>
      <Show when={otherAccount()}>{(name) => <Notice tone="warn">{t().otherAccount({ cloud: props.cloud, name: name() })}</Notice>}</Show>
      <Show when={newVersion()}>
        <Notice tone="note" icon="refresh" actions={[{ label: t().reload, icon: "refresh", onClick: () => location.reload() }]}>
          {t().newVersion({ cloud: props.cloud })}
        </Notice>
      </Show>
    </div>
  );
}
