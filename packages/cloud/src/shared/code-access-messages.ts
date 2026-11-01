/** Platform-generated Code access copy; application refusal reasons remain application-owned. */
export const codeAccessMessages = (locale: string) =>
  locale.toLowerCase().startsWith("de")
    ? {
        setTitle: "Code-Zugriff gewähren",
        setDescription: "Core aktiviert ausdrücklichen Code-Zugriff mit einem signierten Aktivierungsnachweis.",
        listTitle: "Code-Zugriffe auflisten",
        listDescription: "Aktuelle ausdrückliche Code-Zugriffe an Zielen auflisten, die diese Person verwaltet.",
        rmTitle: "Code-Zugriff entfernen",
        rmDescription: "Einen ausdrücklichen Code-Zugriff mit aktueller Verwaltungsberechtigung am Ziel entfernen.",
        setRunning: "Code-Zugriff wird gewährt",
        setDone: "Code-Zugriff gewährt",
        setConfirm: "Zugriff gewähren",
        setAvailable: "Code-Zugriff ist möglich",
        rmRunning: "Code-Zugriff wird entfernt",
        rmDone: "Code-Zugriff entfernt",
        rmConfirm: "Zugriff entfernen",
        rmFailed: "Code-Zugriff konnte nicht entfernt werden",
        cancel: "Abbrechen",
      }
    : {
        setTitle: "Grant Code access",
        setDescription: "Core activates explicit Code access at a target with a signed activation proof.",
        listTitle: "List Code access",
        listDescription: "List current explicit Code grants at targets this person manages.",
        rmTitle: "Remove Code access",
        rmDescription: "Remove an explicit Code grant with current target manager authority.",
        setRunning: "Granting Code access",
        setDone: "Code access granted",
        setConfirm: "Grant access",
        setAvailable: "Code access is available",
        rmRunning: "Removing Code access",
        rmDone: "Code access removed",
        rmConfirm: "Remove access",
        rmFailed: "Code access could not be removed",
        cancel: "Cancel",
      };
