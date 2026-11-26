import type { SettingsDraftOutcome } from "@k2b/cloud/ssr/settings-draft";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Check, Notice } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../messages";

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

export const checkSettingsOutcomeMessages = () => messages.check();

/**
 * What became of the last save when it did not succeed: not saved with the reason and a retry, or an unclear outcome
 * with a way to check the current state instead of saving twice.
 */
export function SettingsOutcome(props: { outcome: SettingsDraftOutcome | null; onRetry: () => void }) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  return (
    <Show when={props.outcome}>
      {(outcome) =>
        outcome().kind === "failed" ? (
          <Notice tone="bad" title={t().notSaved} actions={[{ label: t().retry, icon: "refresh", onClick: props.onRetry }]}>
            {outcome().message} {t().notSavedKeep}
          </Notice>
        ) : (
          <Notice
            tone="warn"
            title={t().unknownOutcome}
            actions={[{ label: t().checkNow, icon: "refresh", onClick: () => location.reload() }]}
          >
            {t().unknownOutcomeKeep}
          </Notice>
        )
      }
    </Show>
  );
}

/**
 * Stored values that cannot be read: the notice, and one box per value to replace it on the next save. Nothing is
 * replaced without that box.
 */
export function UnreadableValues<K extends string>(props: {
  keys: K[];
  label: (key: K) => string;
  replace: Partial<Record<K, boolean>>;
  onReplace: (key: K, replace: boolean) => void;
  disabled: boolean;
}) {
  const locale = useLocale();
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  return (
    <Show when={props.keys.length > 0}>
      <Notice tone="warn" title={g().unreadableTitle}>
        {g().unreadableDetail}
      </Notice>
      <Band>
        <For each={props.keys}>
          {(key) => (
            <Check
              label={`${g().replaceStored}: ${props.label(key)}`}
              checked={props.replace[key] === true}
              onChange={(checked) => props.onReplace(key, checked)}
              disabled={props.disabled}
            />
          )}
        </For>
      </Band>
    </Show>
  );
}
