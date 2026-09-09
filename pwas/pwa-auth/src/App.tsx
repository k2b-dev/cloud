import { Button, Dropdown, type DropdownItem, LocaleProvider, Placeholder, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { consumePairingLocation, createAuthenticator } from "./authenticator";
import { Clouds, openManageAccounts } from "./Clouds";
import { openDialog } from "./dialog";
import { openInstallDialog } from "./InstallDialog";
import { authMessages } from "./i18n";
import { createInstallation } from "./install";
import { Pairing } from "./Pairing";
import type { Preferences } from "./preferences";
import { openSecurity } from "./Security";
import { openSettings } from "./Settings";
import { createVault } from "./vault";

export function App(props: { preferences: Preferences }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const installation = createInstallation();
  const vault = createVault();
  const auth = createAuthenticator(vault);
  let pairingOpen = false;
  let unlockOpen = false;
  const showUnlock = async () => {
    if (
      vault.status() !== "locked" ||
      document.visibilityState !== "visible" ||
      unlockOpen ||
      pairingOpen ||
      installDialogOpen ||
      document.querySelector("dialog[open]")
    )
      return;
    unlockOpen = true;
    try {
      await openSecurity(vault, props.preferences, "unlock");
    } finally {
      unlockOpen = false;
    }
  };
  const showPairing = async (link?: string) => {
    if (pairingOpen) return;
    pairingOpen = true;
    try {
      if (vault.status() === "loading" || vault.status() === "legacy" || vault.status() === "error") return;
      if (vault.status() !== "open") {
        if (!(await openSecurity(vault, props.preferences, vault.status() === "empty" ? "setup" : "unlock"))) return;
      }
      if (vault.status() !== "open") return;
      await openDialog(
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
      void showUnlock();
    }
  };
  const [pendingLink, setPendingLink] = createSignal<string>();
  let initialUnlockChecked = false;
  createEffect(() => {
    if (vault.status() === "loading") return;
    const link = pendingLink();
    if (link) {
      setPendingLink(undefined);
      initialUnlockChecked = true;
      void showPairing(link);
    } else if (!initialUnlockChecked) {
      initialUnlockChecked = true;
      void showUnlock();
    }
  });
  onMount(() => {
    const link = consumePairingLocation();
    if (link) setPendingLink(link);
    else if (installation.shouldIntroduce()) void showInstall();
    const changed = () => {
      const next = consumePairingLocation();
      if (next) setPendingLink(next);
    };
    const resumed = () =>
      queueMicrotask(() => {
        void showUnlock();
      });
    window.addEventListener("hashchange", changed);
    window.addEventListener("focus", resumed);
    document.addEventListener("visibilitychange", resumed);
    onCleanup(() => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("focus", resumed);
      document.removeEventListener("visibilitychange", resumed);
    });
  });
  const items = createMemo<DropdownItem[]>(() => [
    ...(vault.status() === "open"
      ? [
          {
            label: t().manageAccounts,
            action: () => {
              void openManageAccounts(auth, props.preferences);
            },
          },
          {
            label: t().security,
            action: () => {
              void openSecurity(vault, props.preferences, "manage");
            },
          },
          { label: t().lockApp, action: () => vault.lock() },
        ]
      : []),
    ...(["locked", "legacy", "error"].includes(vault.status())
      ? [
          {
            label: t().resetApp,
            action: () => {
              void openSecurity(vault, props.preferences, "reset");
            },
          },
        ]
      : []),
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
          when={vault.status() === "open" || vault.status() === "empty"}
          fallback={
            <section class="auth-welcome">
              <img class="auth-mark" src="/favicon.svg" width="80" height="80" alt="" />
              <Show when={vault.status() === "locked"}>
                <Placeholder title={t().unlockApp} description={t().lockedHelp} />
                <Button onClick={() => void showUnlock()}>{t().unlockApp}</Button>
              </Show>
              <Show when={vault.status() === "legacy"}>
                <Placeholder title={t().legacyTitle} description={t().legacyHelp} />
                <Button onClick={() => void openSecurity(vault, props.preferences, "reset")}>{t().resetApp}</Button>
              </Show>
              <Show when={vault.status() === "loading"}>
                <p role="status">{t().loadingSecurity}</p>
              </Show>
              <Show when={vault.status() === "error"}>
                <p role="alert">{t().storage}</p>
              </Show>
            </section>
          }
        >
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
        </Show>
      </main>
    </div>
  );
}
