import { clipboard } from "@k2b/stdlib/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import type { InstallPrompt } from "./install";

export type InstallGuideProps = {
  /** The name people see on their Home Screen, used in the guidance text. */
  appName: string;
  install: InstallPrompt;
  /** The address an embedded browser copies, to open it in Safari or Chrome. */
  url: string;
  /** An application note under the installation steps, for example what else the installed app enables. */
  note?: string;
  class?: string;
};

/**
 * Explains how to install the current page as an app on this platform: the browser's own dialog where it offers
 * one, otherwise the steps for Safari on iPhone, iPad, and Mac, Android, and other browsers, and for an embedded
 * browser a link to copy into Safari or Chrome. The host owns the surrounding surface, its heading, and dismissal.
 */
export function InstallGuide(props: InstallGuideProps): JSX.Element {
  const messages = useUiMessages();
  const state = props.install;
  const copy = clipboard.createWriter({ write: (url: string) => navigator.clipboard.writeText(url) });
  const steps = createMemo(() => {
    const t = messages();
    if (state.platform === "apple-mobile")
      return [
        { icon: "ti ti-share-2", title: t.installOpenShare, detail: t.installOpenShareDetail },
        { icon: "ti ti-square-plus", title: t.installHomeScreen, detail: t.installHomeScreenDetail },
        { icon: "ti ti-check", title: t.installConfirmAdd, detail: t.installConfirmAddDetail },
      ];
    if (state.platform === "apple-desktop")
      return [
        { icon: "ti ti-share-2", title: t.installSafariMenu, detail: t.installSafariMenuDetail },
        { icon: "ti ti-app-window", title: t.installAddDock, detail: t.installAddDockDetail },
      ];
    return [
      { icon: "ti ti-dots", title: t.installBrowserMenu, detail: t.installBrowserMenuDetail },
      {
        icon: "ti ti-square-plus",
        title: t.installApp,
        detail: state.platform === "android" ? t.installAndroidDetail : t.installBrowserDetail,
      },
    ];
  });
  return (
    <div class={props.class ? `k2b-install-guide ${props.class}` : "k2b-install-guide"} data-platform={state.platform}>
      <Show when={state.failed()}>
        <p role="alert">{messages().installFailed}</p>
      </Show>
      <Show
        when={state.requested()}
        fallback={
          <Show
            when={state.canPrompt() || state.busy()}
            fallback={
              <Show
                when={state.platform === "in-app"}
                fallback={
                  <>
                    <Show when={state.platform === "apple-mobile"}>
                      <p>{messages().installUseSafari}</p>
                    </Show>
                    <ol class="k2b-install-guide__steps">
                      <For each={steps()}>
                        {(step) => (
                          <li>
                            <span class="k2b-install-guide__step-icon">
                              <i class={step.icon} aria-hidden="true" />
                            </span>
                            <div>
                              <h3>{step.title}</h3>
                              <p>{step.detail}</p>
                            </div>
                          </li>
                        )}
                      </For>
                    </ol>
                    <Show when={props.note}>
                      <p>{props.note}</p>
                    </Show>
                    <Show when={state.platform === "generic" || state.platform === "android"}>
                      <p>{messages().installUnavailable}</p>
                    </Show>
                  </>
                }
              >
                <p>{messages().installEmbedded({ appName: props.appName })}</p>
                <Button variant="secondary" onClick={() => void copy.copy(props.url)}>
                  {copy.wasCopied() ? messages().installLinkCopied : messages().installCopyLink}
                </Button>
                <p>{messages().installPasteLink({ appName: props.appName })}</p>
                <Show when={copy.error()}>
                  <p role="alert">{messages().installCopyFailed}</p>
                  <code>{props.url}</code>
                </Show>
              </Show>
            }
          >
            <p>{messages().installNative({ appName: props.appName })}</p>
            <Button loading={state.busy()} onClick={() => void state.install()}>
              {messages().installApp}
            </Button>
          </Show>
        }
      >
        <p role="status">{messages().installRequested}</p>
      </Show>
    </div>
  );
}

export default InstallGuide;
