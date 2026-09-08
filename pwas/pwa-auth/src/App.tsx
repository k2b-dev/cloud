import { Dropdown, type DropdownItem, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, onMount } from "solid-js";
import { openInstallDialog } from "./InstallDialog";
import { authMessages } from "./i18n";
import { createInstallation } from "./install";
import type { Preferences } from "./preferences";
import { openSettings } from "./Settings";

export function App(props: { preferences: Preferences }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const installation = createInstallation();
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
    if (installation.shouldIntroduce()) void showInstall();
  });
  const items = createMemo<DropdownItem[]>(() => [
    { label: t().addCloud, description: t().pairingUnavailable, disabled: true },
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
          <span class="auth-preview">{t().preview}</span>
          <Dropdown.Root items={items()} position="bottom-right" width="16rem">
            <Dropdown.Trigger iconOnly label={t().menu} class="auth-menu-button" tooltip={false}>
              <span aria-hidden="true">···</span>
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </header>
      <main class="auth-main">
        <section class="auth-welcome">
          <img class="auth-mark" src="/favicon.svg" width="80" height="80" alt="" />
          <Placeholder title={t().emptyTitle} description={t().emptyDescription} />
        </section>
      </main>
    </div>
  );
}
