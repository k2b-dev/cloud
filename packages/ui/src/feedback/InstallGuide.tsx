import { clipboard } from "@k2b/stdlib/solid";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Button, ButtonLink } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { NoticeCard } from "../surfaces/NoticeCard";
import type { InstallPrompt } from "./install";

export type InstallGuideProps = {
  /** The name people see on their Home Screen, used in the guidance text. */
  appName: string;
  install: InstallPrompt;
  /**
   * The absolute address of the page to install. A browser inside another app copies it, to open it in Safari or
   * Chrome, and shows it as text when copying fails, so it can be copied by hand. Samsung Internet opens an http or
   * https address in Chrome.
   */
  url: string;
  /**
   * An application note under the installation steps or the embedded browser's link, for example what else the
   * installed app enables.
   */
  note?: string;
  class?: string;
};

/**
 * Opens `url` in Chrome on Android. Without Chrome, the browser loads `url` itself. Only an absolute http or https
 * address has an intent; anything else returns `undefined`.
 */
const chromeIntent = (url: string) => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return undefined;
  const scheme = target.protocol.slice(0, -1);
  return `intent://${target.host}${target.pathname}${target.search}${target.hash}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
};

/**
 * Explains how to install the current page as an app on this platform: the browser's own dialog where it offers
 * one, otherwise the steps for Safari on iPhone, iPad, and Mac, other browsers on iPhone and iPad, Android, and other
 * browsers. A browser inside another app cannot install, so it gets a warning and the link to copy into Safari or
 * Chrome instead. Samsung Internet gets a link to Chrome even when it offers its own dialog, because Android may block
 * the app package it builds. The host owns the surrounding surface, its heading, and dismissal.
 */
export function InstallGuide(props: InstallGuideProps): JSX.Element {
  const messages = useUiMessages();
  // The host may hand over another state after mount, such as the browser's own in place of the server's view.
  const state = () => props.install;
  const copy = clipboard.createWriter({ write: (url: string) => navigator.clipboard.writeText(url) });
  const embedded = () => state().platform === "in-app" || state().platform === "apple-in-app";
  /** A browser that installs, but less reliably than the platform's own. */
  const hint = createMemo(() => {
    const t = messages();
    if (state().platform === "apple-browser") return { title: t.installAppleBrowserTitle, detail: t.installAppleBrowserDetail };
    if (state().platform === "android-browser") return { title: t.installAndroidBrowserTitle, detail: t.installAndroidBrowserDetail };
    return undefined;
  });
  const steps = createMemo(() => {
    const t = messages();
    if (state().platform === "apple-mobile" || state().platform === "apple-browser")
      return [
        {
          icon: "ti ti-share-2",
          title: t.installOpenShare,
          detail: state().platform === "apple-browser" ? t.installOpenShareBrowserDetail : t.installOpenShareDetail,
        },
        { icon: "ti ti-square-plus", title: t.installHomeScreen, detail: t.installHomeScreenDetail },
        { icon: "ti ti-check", title: t.installConfirmAdd, detail: t.installConfirmAddDetail },
      ];
    if (state().platform === "apple-desktop")
      return [
        { icon: "ti ti-share-2", title: t.installSafariMenu, detail: t.installSafariMenuDetail },
        { icon: "ti ti-app-window", title: t.installAddDock, detail: t.installAddDockDetail },
      ];
    return [
      { icon: "ti ti-dots", title: t.installBrowserMenu, detail: t.installBrowserMenuDetail },
      {
        icon: "ti ti-square-plus",
        title: t.installApp,
        detail: state().platform === "android" || state().platform === "android-browser" ? t.installAndroidDetail : t.installBrowserDetail,
      },
    ];
  });
  return (
    <div class={props.class ? `k2b-install-guide ${props.class}` : "k2b-install-guide"} data-platform={state().platform}>
      <Show when={state().failed()}>
        <p role="alert">{messages().installFailed}</p>
      </Show>
      <Switch
        fallback={
          <>
            <Show when={hint()}>{(hint) => <NoticeCard tone="info" title={hint().title} detail={hint().detail} />}</Show>
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
            <Show when={state().platform === "apple-mobile"}>
              <p>{messages().installSafariFallback}</p>
            </Show>
            <Show when={props.note}>
              <p>{props.note}</p>
            </Show>
            <Show when={state().platform === "generic"}>
              <p>{messages().installUnavailable}</p>
            </Show>
          </>
        }
      >
        <Match when={state().requested()}>
          <p role="status">{messages().installRequested}</p>
        </Match>
        <Match when={state().platform === "android-samsung"}>
          <NoticeCard
            tone="info"
            title={messages().installSamsungTitle}
            detail={messages().installSamsungDetail({ appName: props.appName })}
          />
          <Show when={chromeIntent(props.url)}>
            {(href) => (
              <ButtonLink href={href()}>
                <i class="ti ti-brand-chrome" aria-hidden="true" />
                {messages().installOpenChrome}
              </ButtonLink>
            )}
          </Show>
          <Show when={props.note}>
            <p>{props.note}</p>
          </Show>
        </Match>
        <Match when={state().canPrompt() || state().busy()}>
          <p>{messages().installNative({ appName: props.appName })}</p>
          <Button loading={state().busy()} onClick={() => void state().install()}>
            {messages().installApp}
          </Button>
        </Match>
        <Match when={embedded()}>
          <NoticeCard
            tone="warning"
            title={state().platform === "apple-in-app" ? messages().installAppleInAppTitle : messages().installInAppTitle}
            detail={
              state().platform === "apple-in-app"
                ? messages().installAppleInAppDetail({ appName: props.appName })
                : messages().installInAppDetail({ appName: props.appName })
            }
          />
          <Button variant="secondary" onClick={() => void copy.copy(props.url)}>
            <i class={copy.wasCopied() ? "ti ti-check" : "ti ti-copy"} aria-hidden="true" />
            {copy.wasCopied() ? messages().installLinkCopied : messages().installCopyLink}
          </Button>
          <Show when={copy.error()}>
            <p role="alert">{messages().installCopyFailed}</p>
            <code>{props.url}</code>
          </Show>
          <Show when={props.note}>
            <p>{props.note}</p>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

export default InstallGuide;
