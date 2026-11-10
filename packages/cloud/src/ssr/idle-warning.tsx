import { Button, prompts } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import type { IdleWarning } from "../browser/idle-sign-out";
import { sharedWorkstationMessages } from "./shared-workstation-messages";

/**
 * Renders the shared workstation's warning a minute before sign-out. "Weiterarbeiten", the close button and Escape
 * keep working; "Abmelden" leaves at once. Closing it from the watcher, after input in this or another tab, decides
 * nothing.
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
    void prompts
      .dialog<"continue" | "sign-out">(
        (close) => {
          const [seconds, setSeconds] = createSignal(warning.secondsLeft());
          const tick = window.setInterval(() => setSeconds(warning.secondsLeft()), 1_000);
          onCleanup(() => window.clearInterval(tick));
          return (
            // The watcher ignores input here: a press on "Abmelden" must not count as working on.
            <div class="flex flex-col gap-4" data-cloud-idle-warning="">
              <p class="text-sm">{t.warningBody({ seconds: seconds() })}</p>
              <div class="flex justify-end gap-2">
                <Button variant="secondary" size="sm" type="button" onClick={() => close("sign-out")}>
                  {t.signOut}
                </Button>
                <Button size="sm" type="button" onClick={() => close("continue")}>
                  {t.keepWorking}
                </Button>
              </div>
            </div>
          );
        },
        { title: t.warningTitle, variant: "warning", size: "small", signal: current.signal },
      )
      .then((result) => {
        if (open !== current) return;
        open = null;
        if (result === "sign-out") warning.onSignOut();
        else warning.onContinue();
      });
  };
};
