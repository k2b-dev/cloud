import { i18n } from "@k2b/stdlib";

/** Words of the registry forms in Core's admin areas. */
export const areaFormMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sourceCustom: "Own value",
      sourceEnv: "From the environment",
      sourceDefault: "Default",
      useDefault: "Use default",
      undoDefault: "Keep own value",
      defaultApplies: ({ value }: { value: string }) => `After saving, the default applies: ${value}`,
      unreadableTitle: "The stored value cannot be read.",
      unreadableKeep: ({ value }: { value: string }) => `"${value}" applies for now.`,
      replaceStored: ({ label }: { label: string }) => `Replace stored value: ${label}`,
      conflict: ({ who, time }: { who: string; time: string }) => `${who} changed this at ${time}.`,
      someoneElse: "Someone else",
      conflictKeep: ({ value }: { value: string }) => `Now "${value}" applies. Your value is not saved.`,
      takeTheirs: "Take their value",
      keepMine: "Save my value",
      secretSet: "Set. Enter a new value to replace it.",
      secretEmpty: "Not set.",
      emptyValue: "empty",
      saveFailed: "The settings could not be saved.",
      atLeast: ({ min }: { min: number }) => `At least ${min}.`,
      atMost: ({ max }: { max: number }) => `At most ${max}.`,
    },
    de: {
      sourceCustom: "Eigener Wert",
      sourceEnv: "Aus der Umgebung",
      sourceDefault: "Standard",
      useDefault: "Standard verwenden",
      undoDefault: "Eigenen Wert behalten",
      defaultApplies: ({ value }) => `Nach dem Speichern gilt der Standard: ${value}`,
      unreadableTitle: "Der gespeicherte Wert ist nicht lesbar.",
      unreadableKeep: ({ value }) => `Es gilt vorerst „${value}“.`,
      replaceStored: ({ label }) => `Gespeicherten Wert ersetzen: ${label}`,
      conflict: ({ who, time }) => `${who} hat das um ${time} geändert.`,
      someoneElse: "Jemand anderes",
      conflictKeep: ({ value }) => `Jetzt gilt „${value}“. Dein Wert ist nicht gespeichert.`,
      takeTheirs: "Diesen Wert übernehmen",
      keepMine: "Meinen Wert speichern",
      secretSet: "Gesetzt. Gib einen neuen Wert ein, um ihn zu ersetzen.",
      secretEmpty: "Nicht gesetzt.",
      emptyValue: "leer",
      saveFailed: "Die Einstellungen konnten nicht gespeichert werden.",
      atLeast: ({ min }) => `Mindestens ${min}.`,
      atMost: ({ max }) => `Höchstens ${max}.`,
    },
  },
});

export type AreaFormMessages = ReturnType<typeof areaFormMessages.resolve>["t"];
export const checkAreaFormMessages = () => areaFormMessages.check();
