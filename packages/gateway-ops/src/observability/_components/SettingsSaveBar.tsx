import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Text } from "@k2b/ui/v2";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      save: "Save",
      discard: "Discard",
      saved: "Saved",
      savedAt: ({ time }: { time: string }) => `Saved ${time}`,
      draft: "Not saved yet",
      saving: "Saving …",
      failed: "Not saved",
      invalid: ({ count }: { count: number }) => (count === 1 ? "Check 1 entry" : `Check ${count} entries`),
      unknown: "Outcome unclear",
    },
    de: {
      save: "Speichern",
      discard: "Verwerfen",
      saved: "Gespeichert",
      savedAt: ({ time }) => `Gespeichert ${time}`,
      draft: "Noch nicht gespeichert",
      saving: "Wird gespeichert …",
      failed: "Nicht gespeichert",
      invalid: ({ count }) => (count === 1 ? "1 Eingabe prüfen" : `${count} Eingaben prüfen`),
      unknown: "Ausgang unklar",
    },
  },
});

export const checkSettingsSaveBarMessages = () => messages.check();

/**
 * The end of a v2 head for a settings form: its state in words, Discard and Save. The form registers its draft with
 * `settingsSaveControls`; Save stays in the head on the phone too (no floating action), so a form has one Save. Until it registers, the head says "Saved" with both buttons disabled. A form beside a page that has
 * its own primary action saves with a framed button (`primary={false}`).
 */
export function SettingsSaveBar(props: { primary?: boolean } = {}) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const controls = settingsSaveControls;
  const state = () => controls()?.state ?? "saved";
  const text = () => {
    const at = controls()?.savedAt;
    switch (state()) {
      case "saved":
        return at ? t().savedAt({ time: at }) : t().saved;
      case "draft":
        return t().draft;
      case "saving":
        return t().saving;
      case "failed":
        return t().failed;
      case "invalid":
        return t().invalid({ count: controls()?.invalidCount ?? 1 });
      default:
        return t().unknown;
    }
  };
  const pending = () => ["draft", "failed", "invalid", "saving"].includes(state());
  return (
    <>
      <Text type="meta" muted tone={state() === "failed" || state() === "invalid" ? "bad" : state() === "unknown" ? "warn" : undefined}>
        {text()}
      </Text>
      <Button disabled={!pending() || state() === "saving"} onClick={() => controls()?.discard()}>
        {t().discard}
      </Button>
      <Button
        variant={props.primary === false ? undefined : "primary"}
        icon="device-floppy"
        keep
        busy={state() === "saving"}
        disabled={!pending() || state() === "invalid"}
        onClick={() => controls()?.save()}
      >
        {t().save}
      </Button>
    </>
  );
}
