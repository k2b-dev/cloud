import { Button, dialogCore, PanelDialog } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import type { IdleWarning } from "../browser/idle-sign-out";
import { sharedWorkstationMessages } from "./shared-workstation-messages";

/**
 * Renders the shared workstation's warning a minute before sign-out. It offers exactly two ways: "Weiterarbeiten",
 * which has the focus, and "Abmelden". There is no close button, and Escape does nothing: only a person's press of
 * "Weiterarbeiten" (a trusted click, also by Enter or Space) keeps working, so a script can neither keep the session
 * open nor dismiss the question. Closing it from the watcher, after input in another tab, decides nothing.
 */
export const createIdleWarning = (locale: () => string) => {
  let open: AbortController | null = null;
  return (warning: IdleWarning | null): void => {
    open?.abort();
    open = null;
    if (!warning) return;
    const current = new AbortController();
    open = current;
    const t = sharedWorkstationMessages.resolve([locale()]).t;
    void dialogCore
      .open<"continue" | "sign-out">(
        (close) => {
          const [seconds, setSeconds] = createSignal(warning.secondsLeft());
          const tick = window.setInterval(() => setSeconds(warning.secondsLeft()), 1_000);
          onCleanup(() => window.clearInterval(tick));
          return (
            <PanelDialog tone="warning">
              <PanelDialog.Header title={t.warningTitle} />
              <PanelDialog.Body scrollFade={false}>
                <p class="text-sm tabular-nums">{t.warningBody({ seconds: seconds() })}</p>
              </PanelDialog.Body>
              <PanelDialog.Footer>
                <Button variant="secondary" type="button" onClick={() => close("sign-out")}>
                  {t.signOut}
                </Button>
                <Button type="button" data-cloud-idle-continue="" onClick={(event: MouseEvent) => event.isTrusted && close("continue")}>
                  {t.keepWorking}
                </Button>
              </PanelDialog.Footer>
            </PanelDialog>
          );
        },
        {
          // A short question, not an editor: the prompt width, as `AccessDialog` sizes its PanelDialog.
          panelClassName: "k2b-dialog k2b-dialog--small",
          role: "alertdialog",
          ariaLabel: t.warningTitle,
          cancelBehavior: "ignore",
          signal: current.signal,
          initialFocus: (dialog) => dialog.querySelector<HTMLElement>("[data-cloud-idle-continue]"),
        },
      )
      .then((result) => {
        if (open !== current) return;
        open = null;
        if (result === "sign-out") warning.onSignOut();
        else if (result === "continue") warning.onContinue();
        else warning.onClosed();
      });
  };
};
