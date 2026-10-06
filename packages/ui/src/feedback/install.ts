import { createSignal, onCleanup } from "solid-js";

/**
 * Which installation steps a browser needs. `apple-in-app` and `in-app` are browsers embedded in another app, on
 * iPhone or iPad and elsewhere, which cannot install at all. `apple-browser` is Chrome, Firefox, Edge, or another
 * browser on iPhone or iPad, which installs through its Share menu but less reliably than Safari. `android-samsung` is
 * Samsung Internet on Android, whose installed apps Android may block as built for an older Android version.
 * `android-browser` is another Android browser, such as Firefox or Edge.
 */
export type InstallationPlatform =
  | "in-app"
  | "apple-in-app"
  | "apple-browser"
  | "apple-mobile"
  | "apple-desktop"
  | "android-samsung"
  | "android-browser"
  | "android"
  | "generic";

/** Tokens of apps that open links in their own browser view. Case-sensitive, so `Line/` matches only LINE. */
const EMBEDDED =
  /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Twitter|Snapchat|musical_ly|BytedanceWebview|Pinterest|MicroMessenger|\bLine\/|GSA\/|; wv\)/;
/** Browsers on iPhone and iPad other than Safari. */
const APPLE_BROWSER = /CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\/|OPT\/|Ddg\/|DuckDuckGo\/|YaBrowser\//;
/** Android browsers whose user agent also names Chrome. */
const ANDROID_OTHER = /EdgA\/|OPR\/|YaBrowser|Firefox\//;

/**
 * Classifies the browser from its user agent; `platform` and `touchPoints` only tell an iPad that reports a Mac apart.
 * A pure function, so the server and the browser compute the same value from the same user agent. Not a device
 * check: an installed app on iPhone may itself look like an embedded browser.
 */
export function installationPlatform(userAgent: string, platform: string, touchPoints: number): InstallationPlatform {
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) {
    if (EMBEDDED.test(userAgent)) return "apple-in-app";
    if (APPLE_BROWSER.test(userAgent)) return "apple-browser";
    // Safari and every real browser send `Safari/`; a bare web view inside an app, such as a QR scanner, does not.
    if (!/Safari\//.test(userAgent)) return "apple-in-app";
    return "apple-mobile";
  }
  if (EMBEDDED.test(userAgent)) return "in-app";
  if (/Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent)) return "apple-desktop";
  if (/Android/.test(userAgent)) {
    if (/SamsungBrowser\//.test(userAgent)) return "android-samsung";
    return /Chrome\//.test(userAgent) && !ANDROID_OTHER.test(userAgent) ? "android" : "android-browser";
  }
  return "generic";
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && typeof event.prompt === "function";
}

export type InstallPrompt = {
  platform: InstallationPlatform;
  /** Running from the Home Screen or as an installed app, or installed during this visit. */
  installed: () => boolean;
  /** The browser offered its own installation dialog, which `install()` opens. */
  canPrompt: () => boolean;
  busy: () => boolean;
  /** The person accepted the browser's dialog; the browser finishes the installation. */
  requested: () => boolean;
  /** The browser's dialog could not be opened. */
  failed: () => boolean;
  /** Opens the browser's dialog once. Call it directly from a click. */
  install: () => Promise<void>;
};

/**
 * Tracks whether the page runs installed and captures the browser's installation prompt. Browser-only; call it once,
 * when the page loads, under an owner that lives as long as the page: Chrome offers its prompt only once, early.
 */
export function createInstallPrompt(): InstallPrompt {
  const displayMode = matchMedia("(display-mode: standalone)");
  const isStandalone = () => displayMode.matches || ("standalone" in navigator && navigator.standalone === true);
  const [installed, setInstalled] = createSignal(isStandalone());
  const [prompt, setPrompt] = createSignal<BeforeInstallPromptEvent>();
  const [busy, setBusy] = createSignal(false);
  const [requested, setRequested] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const capture = (event: Event) => {
    if (!isInstallPrompt(event)) return;
    event.preventDefault();
    if (installed()) return;
    setPrompt(event);
    setRequested(false);
  };
  const complete = () => {
    setInstalled(true);
    setPrompt(undefined);
  };
  const displayChanged = () => {
    if (isStandalone()) complete();
  };
  window.addEventListener("beforeinstallprompt", capture);
  window.addEventListener("appinstalled", complete);
  displayMode.addEventListener("change", displayChanged);
  onCleanup(() => {
    window.removeEventListener("beforeinstallprompt", capture);
    window.removeEventListener("appinstalled", complete);
    displayMode.removeEventListener("change", displayChanged);
  });
  const install = async () => {
    if (busy() || installed()) return;
    const event = prompt();
    setFailed(false);
    if (!event) return;
    // Consume once, and invoke synchronously within the user's click.
    setPrompt(undefined);
    setBusy(true);
    try {
      const result = await event.prompt();
      if (!installed()) setRequested(result.outcome === "accepted");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return {
    platform: installationPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    installed,
    canPrompt: () => Boolean(prompt()),
    busy,
    requested,
    failed,
    install,
  };
}
