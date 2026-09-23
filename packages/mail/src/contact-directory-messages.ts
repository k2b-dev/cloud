import { i18n } from "@k2b/stdlib";

export const contactDirectoryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Contact directory",
      description:
        "Choose the app that Mail uses for recipient suggestions, participant contacts, and saving new contacts. Mail calls it with each person's own access.",
      back: "Mail",
      app: "App",
      appDescription: "Only apps that publish capabilities are listed.",
      chooseApp: "Choose an app",
      appUnavailable: ({ appId }: { appId: string }) => `${appId} (not installed)`,
      chooseCapability: "Choose a capability",
      noCompatibleCapability: "No compatible capability",
      notUsed: "Not used",
      suggest: "Suggest recipients",
      suggestDescription: "Suggestions while typing recipients. Required.",
      resolve: "Match participants",
      resolveDescription: "Contacts for the people in a conversation and in Assistant drafts. Required.",
      read: "Read a contact",
      readDescription: "Write an email to a contact opened from another app. Optional.",
      listWritableBooks: "List writable books",
      listWritableBooksDescription: "Where New contact can save. Optional; needs Create a contact.",
      create: "Create a contact",
      createDescription: "New contact in conversation details. Optional; needs List writable books.",
      save: "Save",
      reset: "Use Contacts defaults",
      saved: "Contact directory saved.",
      saveFailed: "Could not save the contact directory.",
      fixBeforeSaving: "Mail cannot use this mapping yet.",
      currentMappingProblem: "The saved mapping no longer matches the contact-directory contract. Affected features are unavailable.",
      catalogUnavailable: "The capability catalog is unavailable, so apps cannot be checked right now. Try again later.",
      currentValue: "Current setting",
      appMissing: ({ appId }: { appId: string }) =>
        `${appId} is not installed or publishes no capabilities. Choose another app or start it first.`,
      required: ({ name }: { name: string }) => `Choose a capability for “${name}”. Mail needs it.`,
      capabilityMissing: ({ name, id }: { name: string; id: string }) => `“${name}”: ${id} does not exist in this app.`,
      wrongKind: ({ name, id, kind }: { name: string; id: string; kind: "query" | "action" }) =>
        `“${name}”: ${id} must be ${kind === "query" ? "a Query" : "an Action"}.`,
      unsupportedOperation: ({ name, id }: { name: string; id: string }) =>
        `“${name}”: ${id} must require an idempotency key and must not stream its result.`,
      inputMismatch: ({ name, id, path }: { name: string; id: string; path: string }) =>
        `“${name}”: ${id} does not accept the contract input at ${path}.`,
      dataMismatch: ({ name, id, path }: { name: string; id: string; path: string }) =>
        `“${name}”: ${id} can return a result that does not match the contract at ${path}.`,
      pairedFunction: "New contact needs both List writable books and Create a contact. Map both or neither.",
    },
    de: {
      title: "Kontaktverzeichnis",
      description:
        "Wähle die App, die Mail für Empfängervorschläge, Kontakte von Beteiligten und neue Kontakte verwendet. Mail ruft sie mit den eigenen Rechten der jeweiligen Person auf.",
      back: "Mail",
      app: "App",
      appDescription: "Nur Apps, die Capabilities veröffentlichen, werden angezeigt.",
      chooseApp: "App auswählen",
      appUnavailable: ({ appId }: { appId: string }) => `${appId} (nicht installiert)`,
      chooseCapability: "Capability auswählen",
      noCompatibleCapability: "Keine passende Capability",
      notUsed: "Nicht verwendet",
      suggest: "Empfänger vorschlagen",
      suggestDescription: "Vorschläge bei der Eingabe von Empfängern. Erforderlich.",
      resolve: "Beteiligte zuordnen",
      resolveDescription: "Kontakte zu den Personen einer Konversation und in Assistant-Entwürfen. Erforderlich.",
      read: "Kontakt lesen",
      readDescription: "E-Mail an einen Kontakt schreiben, der in einer anderen App geöffnet wurde. Optional.",
      listWritableBooks: "Beschreibbare Bücher auflisten",
      listWritableBooksDescription: "Wohin „Neuer Kontakt“ speichern kann. Optional; benötigt „Kontakt anlegen“.",
      create: "Kontakt anlegen",
      createDescription: "„Neuer Kontakt“ in den Konversationsdetails. Optional; benötigt „Beschreibbare Bücher auflisten“.",
      save: "Speichern",
      reset: "Contacts-Standard verwenden",
      saved: "Kontaktverzeichnis gespeichert.",
      saveFailed: "Das Kontaktverzeichnis konnte nicht gespeichert werden.",
      fixBeforeSaving: "Mail kann diese Zuordnung noch nicht verwenden.",
      currentMappingProblem:
        "Die gespeicherte Zuordnung passt nicht mehr zum Kontaktverzeichnis-Vertrag. Betroffene Funktionen sind nicht verfügbar.",
      catalogUnavailable:
        "Der Capability-Katalog ist nicht erreichbar, daher können Apps gerade nicht geprüft werden. Versuche es später erneut.",
      currentValue: "Aktuelle Einstellung",
      appMissing: ({ appId }: { appId: string }) =>
        `${appId} ist nicht installiert oder veröffentlicht keine Capabilities. Wähle eine andere App oder starte sie zuerst.`,
      required: ({ name }: { name: string }) => `Wähle eine Capability für „${name}“. Mail benötigt sie.`,
      capabilityMissing: ({ name, id }: { name: string; id: string }) => `„${name}“: ${id} gibt es in dieser App nicht.`,
      wrongKind: ({ name, id, kind }: { name: string; id: string; kind: "query" | "action" }) =>
        `„${name}“: ${id} muss eine ${kind === "query" ? "Query" : "Action"} sein.`,
      unsupportedOperation: ({ name, id }: { name: string; id: string }) =>
        `„${name}“: ${id} muss einen Idempotenzschlüssel verlangen und darf ihr Ergebnis nicht streamen.`,
      inputMismatch: ({ name, id, path }: { name: string; id: string; path: string }) =>
        `„${name}“: ${id} akzeptiert die Vertragseingabe bei ${path} nicht.`,
      dataMismatch: ({ name, id, path }: { name: string; id: string; path: string }) =>
        `„${name}“: ${id} kann bei ${path} ein Ergebnis liefern, das nicht zum Vertrag passt.`,
      pairedFunction: "„Neuer Kontakt“ benötigt „Beschreibbare Bücher auflisten“ und „Kontakt anlegen“. Ordne beide oder keine zu.",
    },
  },
});
