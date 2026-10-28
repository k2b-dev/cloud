import { i18n } from "@k2b/stdlib";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { SettingsDraftOutcome } from "./settings-draft";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      notSaved: "Not saved.",
      notSavedKeep: "The previous values still apply. Your changes stay here.",
      unknownOutcome: "The connection broke while saving.",
      unknownOutcomeKeep: "Whether the new values apply is open. Cloud does not save again on its own.",
      checkNow: "Check current state",
      retry: "Try again",
    },
    de: {
      notSaved: "Nicht gespeichert.",
      notSavedKeep: "Es gelten weiter die alten Werte. Deine Änderungen bleiben hier stehen.",
      unknownOutcome: "Die Verbindung brach beim Speichern ab.",
      unknownOutcomeKeep: "Ob die neuen Werte gelten, ist offen. Cloud speichert nicht von selbst noch einmal.",
      checkNow: "Stand jetzt prüfen",
      retry: "Erneut versuchen",
    },
  },
});

export const checkSettingsSaveOutcomeMessages = () => messages.check();

/**
 * What became of the last save when it did not succeed, above the form: not saved with the reason and a retry, or an
 * unclear outcome with a way to check the current state instead of saving twice.
 */
export default function SettingsSaveOutcome(props: { outcome: SettingsDraftOutcome | null; onRetry: () => void }) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  return (
    <Show when={props.outcome}>
      {(outcome) =>
        outcome().kind === "failed" ? (
          <InlineGuidance tone="danger" icon="ti ti-alert-triangle">
            <b>{t().notSaved}</b> {outcome().message} {t().notSavedKeep}{" "}
            <Button type="button" variant="ghost" size="xs" onClick={props.onRetry}>
              {t().retry}
            </Button>
          </InlineGuidance>
        ) : (
          <InlineGuidance tone="warning" icon="ti ti-help-circle">
            <b>{t().unknownOutcome}</b> {t().unknownOutcomeKeep}{" "}
            <Button type="button" variant="ghost" size="xs" onClick={() => window.location.reload()}>
              {t().checkNow}
            </Button>
          </InlineGuidance>
        )
      }
    </Show>
  );
}
