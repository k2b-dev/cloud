import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const settingsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sectionsLabel: ({ title }: { title: string }) => `${title} sections`,
      moveDown: "Move down",
      moveUp: "Move up",
      moveNamedDown: ({ label }: { label: string }) => `Move ${label} down`,
      moveNamedUp: ({ label }: { label: string }) => `Move ${label} up`,
      saveChanges: "Save changes",
      save: "Save",
      saving: "Saving",
      unsaved: "Unsaved",
      unsavedChangeLabel: ({ count }: { count: number }) => `unsaved ${count === 1 ? "change" : "changes"}`,
      noUnsavedChanges: "No unsaved changes",
      statusSaved: "Saved",
      statusSavedAt: ({ time }: { time: string }) => `Saved ${time}`,
      statusDraft: "Draft",
      statusFailed: "Not saved",
      statusInvalid: ({ count }: { count: number }) => (count === 1 ? "Check 1 entry" : `Check ${count} entries`),
      statusUnknown: "Outcome unclear",
      statusReadOnly: "Read only",
    },
    de: {
      sectionsLabel: ({ title }) => `Bereiche von ${title}`,
      moveDown: "Nach unten",
      moveUp: "Nach oben",
      moveNamedDown: ({ label }) => `${label} nach unten verschieben`,
      moveNamedUp: ({ label }) => `${label} nach oben verschieben`,
      saveChanges: "Änderungen speichern",
      save: "Speichern",
      saving: "Wird gespeichert",
      unsaved: "Ungespeichert",
      unsavedChangeLabel: ({ count }) => `ungespeicherte ${count === 1 ? "Änderung" : "Änderungen"}`,
      noUnsavedChanges: "Keine ungespeicherten Änderungen",
      statusSaved: "Gespeichert",
      statusSavedAt: ({ time }) => `Gespeichert ${time}`,
      statusDraft: "Entwurf",
      statusFailed: "Nicht gespeichert",
      statusInvalid: ({ count }) => (count === 1 ? "1 Eingabe prüfen" : `${count} Eingaben prüfen`),
      statusUnknown: "Ausgang unklar",
      statusReadOnly: "Nur lesen",
    },
  },
});

export type SettingsMessages = ReturnType<(typeof settingsMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useSettingsMessages = (): (() => SettingsMessages) => {
  const locale = useLocale();
  return () => settingsMessages.resolve([locale()]).t;
};

export const checkSettingsMessages = () => settingsMessages.check();
