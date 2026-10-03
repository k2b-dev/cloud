import { createSignal, onCleanup } from "solid-js";

/** Which installation steps a browser needs; `in-app` is an embedded browser that cannot install at all. */
export type InstallationPlatform = "in-app" | "apple-mobile" | "apple-desktop" | "android" | "generic";

export function installationPlatform(userAgent: string, platform: string, touchPoints: number): InstallationPlatform {
  if (/Instagram|FBAN|FBAV|Line\/|Telegram|; wv\)/i.test(userAgent)) return "in-app";
  // iPadOS reports a Mac; only touch points tell them apart.
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) return "apple-mobile";
  if (/Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent)) return "apple-desktop";
  if (/Android/.test(userAgent)) return "android";
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
