import { clipboard } from "@k2b/stdlib/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { InstallationPlatform, InstallPrompt } from "../feedback/install";
import { useInstallMessages } from "../feedback/install-messages";
import { Button } from "./button";
import { Notice } from "./components";
import { Row, Text } from "./content";

// ── Only ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OnlyProps = {
  /**
   * Where its content shows: `installed` in the app opened from the Home Screen or the dock, `browser` in a browser
   * tab; `touch` where the main pointer is a finger, `pointer` where it is a mouse or a trackpad.
   */
  when: "installed" | "browser" | "touch" | "pointer";
  children: JSX.Element;
};

/**
 * Content for one kind of device or window only. The stylesheet picks it from the server's page on, so the first
 * picture already is the final one and nothing moves when the page comes alive. Elsewhere it is not in the layout and
 * not read out. Its content takes the place of `Only` itself.
 */
export const Only = (props: OnlyProps) => (
  <div class="k2-only" data-k2-part="Only" data-when={props.when}>
    {props.children}
  </div>
);

/**
 * The installation state the server knows: the platform the request's user agent names, with nothing offered yet. The
 * browser's own (`createInstallPrompt`) takes its place once the page is alive.
 */
export const serverInstall = (platform: InstallationPlatform): InstallPrompt => ({
  platform,
  installed: () => false,
  canPrompt: () => false,
  busy: () => false,
  requested: () => false,
  failed: () => false,
  install: async () => {},
});

// ── InstallGuide ─────────────────────────────────────────────────────────────────────────────────────────────────

export type InstallGuideProps = {
  /** The name people see on their Home Screen, in the guidance. */
  appName: string;
  /**
   * The browser's installation state (`createInstallPrompt`, in the browser). On the server, pass `serverInstall` with
   * the platform the request's user agent names (`installationPlatform`); the browser's own state then takes its place.
   */
  install: InstallPrompt;
  /**
   * The absolute address of the page to install. A browser inside another app copies it, to open it in Safari or
   * Chrome, and shows it when copying fails. Samsung Internet opens an http or https address in Chrome.
   */
  url: string;
  /** A note of the app under the guidance, such as what else the installed app enables. */
  note?: string;
};

/** Browsers that may offer their own installation dialog after the page loads. */
const MAY_PROMPT: ReadonlySet<InstallationPlatform> = new Set(["android", "android-browser", "generic"]);

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
 * How to install the current page as an app on this platform, made of v2 parts: the browser's own dialog where it
 * offers one, otherwise the steps for Safari on iPhone, iPad and Mac, other browsers on iPhone and iPad, Android and
 * other browsers. A browser inside another app cannot install: it gets a warning and the link to copy into Safari or
 * Chrome. Samsung Internet gets a link to Chrome, because Android may block the app package it builds.
 *
 * Where a browser may offer its dialog only after the page loads (Chrome, Edge), the server's page already holds both
 * the steps and the dialog's button in one place, as tall as the taller; the stylesheet shows the one that applies, so
 * nothing moves when the dialog becomes available. The host owns the surface, its heading and dismissal.
 */
export const InstallGuide = (props: InstallGuideProps) => {
  const messages = useInstallMessages();
  const t = () => messages();
  const state = () => props.install;
  const copy = clipboard.createWriter({ write: (url: string) => navigator.clipboard.writeText(url) });
  const platform = () => state().platform;
  const embedded = () => platform() === "in-app" || platform() === "apple-in-app";
  /** A browser that installs, but less reliably than the platform's own. */
  const hint = createMemo(() => {
    if (platform() === "apple-browser") return { title: t().installAppleBrowserTitle, detail: t().installAppleBrowserDetail };
    if (platform() === "android-browser") return { title: t().installAndroidBrowserTitle, detail: t().installAndroidBrowserDetail };
    return undefined;
  });
  const steps = createMemo(() => {
    if (platform() === "apple-mobile" || platform() === "apple-browser")
      return [
        {
          icon: "share-2",
          title: t().installOpenShare,
          detail: platform() === "apple-browser" ? t().installOpenShareBrowserDetail : t().installOpenShareDetail,
        },
        { icon: "square-plus", title: t().installHomeScreen, detail: t().installHomeScreenDetail },
        { icon: "check", title: t().installConfirmAdd, detail: t().installConfirmAddDetail },
      ];
    if (platform() === "apple-desktop")
      return [
        { icon: "share-2", title: t().installSafariMenu, detail: t().installSafariMenuDetail },
        { icon: "app-window", title: t().installAddDock, detail: t().installAddDockDetail },
      ];
    return [
      { icon: "dots", title: t().installBrowserMenu, detail: t().installBrowserMenuDetail },
      {
        icon: "square-plus",
        title: t().installApp,
        detail: platform() === "android" || platform() === "android-browser" ? t().installAndroidDetail : t().installBrowserDetail,
      },
    ];
  });
  const note = () => (
    <Show when={props.note}>
      <Text>{props.note}</Text>
    </Show>
  );
  const stepsView = () => (
    <>
      <Show when={hint()}>
        {(hint) => (
          <Notice tone="info" title={hint().title}>
            {hint().detail}
          </Notice>
        )}
      </Show>
      <ol class="k2-install-steps">
        <For each={steps()}>
          {(step) => (
            <li>
              <Row icon={step.icon} lines={[step.title, step.detail]} />
            </li>
          )}
        </For>
      </ol>
      <Show when={platform() === "apple-mobile"}>
        <Text muted>{t().installSafariFallback}</Text>
      </Show>
      {note()}
      <Show when={platform() === "generic"}>
        <Text muted>{t().installUnavailable}</Text>
      </Show>
    </>
  );
  // the browser's own dialog: offered, opening, or accepted
  const promptView = () => (
    <Show
      when={!state().requested()}
      fallback={
        <div role="status">
          <Text>{t().installRequested}</Text>
        </div>
      }
    >
      <Text>{t().installNative({ appName: props.appName })}</Text>
      <Button variant="primary" icon="download" busy={state().busy()} onClick={() => void state().install()}>
        {t().installApp}
      </Button>
    </Show>
  );
  const prompting = () => state().canPrompt() || state().busy() || state().requested();
  return (
    <div class="k2-install" data-k2-part="InstallGuide" data-platform={platform()}>
      <Show when={state().failed()}>
        <Notice tone="bad">{t().installFailed}</Notice>
      </Show>
      <Show when={platform() === "android-samsung"}>
        <Notice tone="info" title={t().installSamsungTitle}>
          {t().installSamsungDetail({ appName: props.appName })}
        </Notice>
        <Show when={chromeIntent(props.url)}>
          {(href) => (
            <Button variant="primary" icon="brand-chrome" href={href()}>
              {t().installOpenChrome}
            </Button>
          )}
        </Show>
        {note()}
      </Show>
      <Show when={embedded()}>
        <Notice tone="warn" title={platform() === "apple-in-app" ? t().installAppleInAppTitle : t().installInAppTitle}>
          {platform() === "apple-in-app"
            ? t().installAppleInAppDetail({ appName: props.appName })
            : t().installInAppDetail({ appName: props.appName })}
        </Notice>
        <Button variant="secondary" icon={copy.wasCopied() ? "check" : "copy"} onClick={() => void copy.copy(props.url)}>
          {copy.wasCopied() ? t().installLinkCopied : t().installCopyLink}
        </Button>
        <Show when={copy.error()}>
          <div role="alert">
            <Text>{t().installCopyFailed}</Text>
          </div>
          <Text>{props.url}</Text>
        </Show>
        {note()}
      </Show>
      <Show when={!embedded() && platform() !== "android-samsung"}>
        <Show when={MAY_PROMPT.has(platform())} fallback={stepsView()}>
          {/* both in one place, as tall as the taller: the stylesheet shows the one that applies */}
          <div class="k2-install-place" data-shows={prompting() ? "prompt" : "steps"}>
            <div class="k2-install-variant" data-variant="steps">
              {stepsView()}
            </div>
            <div class="k2-install-variant" data-variant="prompt">
              {promptView()}
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};
