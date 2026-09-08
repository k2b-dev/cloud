import { localStore } from "@k2b/stdlib/solid";
import { createSignal, onCleanup } from "solid-js";

export function installationPlatform(userAgent: string, platform: string, touchPoints: number) {
  if (/Instagram|FBAN|FBAV|Line\/|Telegram|; wv\)/i.test(userAgent)) return "in-app";
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) return "apple-mobile";
  if (/Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent)) return "apple-desktop";
  if (/Android/.test(userAgent)) return "android";
  return "generic";
}

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isInstallPrompt(event: Event): event is InstallPrompt {
  return "prompt" in event && typeof event.prompt === "function";
}

export function createInstallation() {
  const [notice, setNotice] = localStore.create("pwa-auth.install-hint", { seen: false });
  const displayMode = matchMedia("(display-mode: standalone)");
  const isStandalone = () => displayMode.matches || ("standalone" in navigator && navigator.standalone === true);
  const [installed, setInstalled] = createSignal(isStandalone());
  const [prompt, setPrompt] = createSignal<InstallPrompt>();
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
    installed,
    busy,
    requested,
    failed,
    install,
    platform: installationPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    canPrompt: () => Boolean(prompt()),
    shouldIntroduce: () => notice.seen !== true && !installed(),
    markIntroduced: () => setNotice("seen", true),
  };
}

export type Installation = ReturnType<typeof createInstallation>;
