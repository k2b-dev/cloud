import { clipboard } from "@k2b/stdlib/solid";
import { Button, LocaleProvider, PanelDialog, useLocale } from "@k2b/ui";
import { createEffect, createMemo, For, Show } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Installation } from "./install";
import type { Preferences } from "./preferences";

function InstallDialog(props: { installation: Installation; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const state = props.installation;
  const copy = clipboard.createWriter({ write: (url: string) => navigator.clipboard.writeText(url) });
  createEffect(() => {
    if (state.installed()) props.close();
  });
  const steps = createMemo(() => {
    if (state.platform === "apple-mobile")
      return [
        { icon: "ti ti-share-2", title: t().share, detail: t().shareDetail },
        { icon: "ti ti-square-plus", title: t().homeScreen, detail: t().homeScreenDetail },
        { icon: "ti ti-check", title: t().add, detail: t().addDetail },
      ];
    if (state.platform === "apple-desktop")
      return [
        { icon: "ti ti-share-2", title: t().safariMenu, detail: t().safariMenuDetail },
        { icon: "ti ti-app-window", title: t().addDock, detail: t().addDockDetail },
      ];
    return [
      { icon: "ti ti-dots", title: t().browserMenu, detail: t().browserMenuDetail },
      {
        icon: "ti ti-square-plus",
        title: t().install,
        detail: state.platform === "android" ? t().androidInstallDetail : t().browserInstallDetail,
      },
    ];
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
          <Show when={state.failed()}>
            <p role="alert">{t().installFailed}</p>
          </Show>
          <Show
            when={state.requested()}
            fallback={
              <Show
                when={state.canPrompt() || state.busy()}
                fallback={
                  <Show
                    when={state.platform === "in-app"}
                    fallback={
                      <>
                        <Show when={state.platform === "apple-mobile"}>
                          <p>{t().useSafari}</p>
                        </Show>
                        <ol class="auth-install-steps">
                          <For each={steps()}>
                            {(step) => (
                              <li>
                                <span class="auth-step-icon">
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
                        <Show when={state.platform === "generic" || state.platform === "android"}>
                          <p class="auth-install-note">{t().browserUnavailable}</p>
                        </Show>
                      </>
                    }
                  >
                    <p>{t().embeddedBrowser}</p>
                    <Button variant="secondary" onClick={() => void copy.copy(`${location.origin}/`)}>
                      {copy.wasCopied() ? t().linkCopied : t().copyLink}
                    </Button>
                    <p class="auth-install-note">{t().pasteLink}</p>
                    <Show when={copy.error()}>
                      <p role="alert">{t().copyFailed}</p>
                      <code>{`${location.origin}/`}</code>
                    </Show>
                  </Show>
                }
              >
                <p>{t().nativeInstallDetail}</p>
                <Button loading={state.busy()} onClick={() => void state.install()}>
                  {t().install}
                </Button>
              </Show>
            }
          >
            <p role="status">{t().installRequested}</p>
          </Show>
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
