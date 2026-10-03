import { Button, InstallGuide, LocaleProvider, PanelDialog, useLocale } from "@k2b/ui";
import { createEffect, createMemo } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Installation } from "./install";
import type { Preferences } from "./preferences";

function InstallDialog(props: { installation: Installation; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  createEffect(() => {
    if (props.installation.installed()) props.close();
  });
  return (
    <PanelDialog>
      <PanelDialog.Body>
        <div class="auth-install-dialog">
          <header class="auth-install-heading">
            <img src="/icons/icon-192.png" width="64" height="64" alt="" />
            <div>
              <h2>{t().installTitle}</h2>
              <p>{t().installSubtitle}</p>
            </div>
          </header>
          <InstallGuide
            appName={t().appName}
            install={props.installation}
            url={`${location.origin}/`}
            note={
              props.installation.platform === "apple-mobile"
                ? t().pushInstallNote
                : props.installation.platform === "in-app"
                  ? t().installFromMenu
                  : undefined
            }
          />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="ghost" onClick={props.close}>
          {t().continueBrowser}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function openInstallDialog(installation: Installation, preferences: Preferences) {
  installation.markIntroduced();
  return openDialog(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <InstallDialog installation={installation} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
