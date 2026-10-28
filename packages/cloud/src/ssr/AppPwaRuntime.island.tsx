import { Button, createInstallPrompt, InstallGuide, type InstallPrompt, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { AppInstallable } from "../contracts/installable";
import { appPwaMessages } from "./app-pwa-messages";

/** Only the App-PWA browser lifecycle. No Cloud mobile-app session, identity, or persistent state. */
export default function AppPwaRuntime(props: { app: AppInstallable }) {
  const locale = useLocale();
  const t = () => appPwaMessages.resolve([locale()]).t;
  const [installation, setInstallation] = createSignal<InstallPrompt>();
  const [installUrl, setInstallUrl] = createSignal("");
  const [workerFailed, setWorkerFailed] = createSignal(false);
  const [registering, setRegistering] = createSignal(false);
  let disposed = false;

  const register = async () => {
    if (registering()) return;
    setRegistering(true);
    try {
      if (!navigator.serviceWorker) throw new Error("Service workers unavailable");
      await navigator.serviceWorker.register(`${props.app.path}sw.js`, { scope: props.app.path, updateViaCache: "none" });
      if (!disposed) setWorkerFailed(false);
    } catch {
      if (!disposed) setWorkerFailed(true);
    } finally {
      if (!disposed) setRegistering(false);
    }
  };

  onMount(() => {
    setInstallation(createInstallPrompt());
    setInstallUrl(new URL(props.app.path, location.origin).href);
    const syncTheme = () => {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      document.querySelector<HTMLMetaElement>("meta[data-app-pwa-theme]")?.setAttribute("content", props.app.themeColor[theme]);
      document
        .querySelector<HTMLLinkElement>("link[data-app-pwa-manifest]")
        ?.setAttribute("href", `${props.app.path}manifest.webmanifest?theme=${theme}`);
      document
        .querySelector<HTMLLinkElement>("link[data-app-pwa-apple]")
        ?.setAttribute("href", `${props.app.path}apple-touch-icon-${theme}.png`);
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    void register();
    onCleanup(() => {
      disposed = true;
      observer.disconnect();
    });
  });

  return (
    <div data-app-pwa-runtime aria-live="polite">
      <Show when={installation()}>
        {(install) => (
          <Show
            when={
              !install().installed() &&
              (install().platform.startsWith("apple-") ||
                install().canPrompt() ||
                install().busy() ||
                install().requested() ||
                install().failed())
            }
          >
            <NoticeCard title={t().title({ name: props.app.name })}>
              <InstallGuide appName={props.app.name} install={install()} url={installUrl()} />
            </NoticeCard>
          </Show>
        )}
      </Show>
      <Show when={workerFailed()}>
        <NoticeCard tone="warning" title={t().workerFailed}>
          <Button variant="secondary" loading={registering()} onClick={() => void register()}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
    </div>
  );
}
