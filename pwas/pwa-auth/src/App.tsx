import { Button, Dropdown, type DropdownItem, dialogCore, LocaleProvider, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, onCleanup, onMount, Show } from "solid-js";
import { consumePairingLocation, createAuthenticator } from "./authenticator";
import { Clouds } from "./Clouds";
import { openInstallDialog } from "./InstallDialog";
import { authMessages } from "./i18n";
import { createInstallation } from "./install";
import { Pairing } from "./Pairing";
import type { Preferences } from "./preferences";
import { openSettings } from "./Settings";

export function App(props: { preferences: Preferences }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const installation = createInstallation();
  const auth = createAuthenticator();
  let pairingOpen = false;
  const showPairing = async (link?: string) => {
    if (pairingOpen) return;
    pairingOpen = true;
    try {
      await dialogCore.open(
        (close) => (
          <LocaleProvider locale={props.preferences.locale()}>
            <Pairing auth={auth} link={link} close={() => close()} />
          </LocaleProvider>
        ),
        { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
      );
    } finally {
      pairingOpen = false;
    }
  };
  let installDialogOpen = false;
  const showInstall = async () => {
    if (installDialogOpen || installation.installed()) return;
    installDialogOpen = true;
    try {
      await openInstallDialog(installation, props.preferences);
    } finally {
      installDialogOpen = false;
    }
  };
  onMount(() => {
    const link = consumePairingLocation();
    if (link) void showPairing(link);
    else if (installation.shouldIntroduce()) void showInstall();
    const changed = () => {
      const next = consumePairingLocation();
      if (next) void showPairing(next);
    };
    window.addEventListener("hashchange", changed);
    onCleanup(() => window.removeEventListener("hashchange", changed));
  });
  const items = createMemo<DropdownItem[]>(() => [
    {
      label: t().addCloud,
      action: () => {
        void showPairing();
      },
    },
    {
      label: t().language,
      action: () => {
        void openSettings(props.preferences, "language");
      },
    },
    {
      label: t().appearance,
      action: () => {
        void openSettings(props.preferences, "theme");
      },
    },
    ...(!installation.installed()
      ? [
          {
            label: t().install,
            action: () => {
              void showInstall();
            },
          },
        ]
      : []),
  ]);
  return (
    <div class="auth-app">
      <header class="auth-header">
        <h1>{t().appName}</h1>
        <div class="auth-header-actions">
          <Dropdown.Root items={items()} align="end" width="16rem">
            <Dropdown.Trigger iconOnly label={t().menu} class="auth-menu-button" tooltip={false}>
              <span aria-hidden="true">···</span>
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </header>
      <main class="auth-main">
        <Show when={auth.storageError()}>
          <p role="alert">{t().storage}</p>
        </Show>
        <Show when={!auth.online()}>
          <p role="status">{t().offline}</p>
        </Show>
        <Show
          when={auth.bindings().length > 0}
          fallback={
            <section class="auth-welcome">
              <img class="auth-mark" src="/favicon.svg" width="80" height="80" alt="" />
              <Placeholder title={t().emptyTitle} description={t().emptyDescription} />
              <Button
                onClick={() => {
                  void showPairing();
                }}
              >
                {t().addCloud}
              </Button>
            </section>
          }
        >
          <Clouds auth={auth} preferences={props.preferences} />
        </Show>
      </main>
    </div>
  );
}
