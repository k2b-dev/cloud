import { Notice, NoticeStack, PageHosts, useLocale } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { pwaFrameColors } from "../contracts/pwa-frame-colors";
import { pwaMessages } from "./pwa-messages";
import { type PwaRuntimeProps, startPwaRuntime, THEME_PREFERENCE_EVENT } from "./pwa-runtime";

/**
 * The browser side of a v2 mobile app page (`PwaLayout ui="v2"`): the runtime of every app page, and what it finds
 * as v2 notices that float above the tab bar and stay until their state ends or the person hides them: offline,
 * Chrome signed in to another account, a new version with "Reload", in a v2 `NoticeStack`. They float, so nothing on
 * the page moves when one comes or goes, and the panes keep their room free; "Hide" takes one away. A hidden offline
 * notice comes again the next time the phone goes offline.
 *
 * The frame renders its `Workspace` on the server without a script, so this island also holds the page's hosts
 * (`PageHosts`): every `useToast` and `Dialog.confirm` of the page's islands answers there, one host per page.
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
    // After a change of theme the status bar and the ground take the frame's colours again, as the page's head gave
    // them: the head's on the phone, the canvas beside the rail.
    const syncTheme = () => {
      const { metas, css } = pwaFrameColors(document.documentElement.classList.contains("dark") ? "dark" : "light");
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
      for (const { media, content } of metas) {
        const meta = document.createElement("meta");
        meta.setAttribute("name", "theme-color");
        meta.setAttribute("media", media);
        meta.setAttribute("content", content);
        document.head.append(meta);
      }
      const ground = document.querySelector("style[data-cloud-canvas]");
      if (ground) ground.textContent = css;
    };
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    onCleanup(() => {
      stop();
      window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    });
  });

  return (
    <>
      <PageHosts />
      <NoticeStack>
        <Show when={offline()}>
          <Notice tone="warn" icon="wifi-off" actions={[{ label: t().hide, onClick: () => setOffline(false) }]}>
            {t().offlineConsequence}
          </Notice>
        </Show>
        <Show when={otherAccount()}>
          {(name) => (
            <Notice tone="warn" title={t().otherAccountTitle} actions={[{ label: t().hide, onClick: () => setOtherAccount(undefined) }]}>
              {t().otherAccount({ cloud: props.cloud, name: name() })}
            </Notice>
          )}
        </Show>
        <Show when={newVersion()}>
          <Notice
            tone="info"
            icon="refresh"
            actions={[
              { label: t().reload, icon: "refresh", onClick: () => location.reload() },
              { label: t().hide, onClick: () => setNewVersion(false) },
            ]}
          >
            {t().newVersion({ cloud: props.cloud })}
          </Notice>
        </Show>
      </NoticeStack>
    </>
  );
}
