import { i18n } from "@k2b/stdlib";

/** The app's name; without one the notice says "This app", never its id. */
type Name = { name?: string };

/** What an open page says while the Cloud is in maintenance or one app restarts. Wording follows the gateway's page. */
export const maintenanceNoticeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      maintenance: "Maintenance in progress",
      maintenanceKeeps: "Your input stays here. Saving and sending work again after the maintenance.",
      maintenanceBlocked: "Maintenance in progress. This works again once maintenance is over.",
      maintenanceEnded: "Maintenance finished",
      appUpdating: ({ name }: Name) => `${name ?? "This app"} is being updated`,
      appUpdatingKeeps: "Your input stays here. Saving and sending work again once the update is finished.",
      appUpdatingBlocked: ({ name }: Name) => `${name ?? "This app"} is being updated. This works again once the update is finished.`,
      appUpdated: "Update finished",
      appDown: ({ name }: Name) => `${name ?? "This app"} is not available right now`,
      appDownKeeps: ({ name }: Name) => `Your input stays here. Saving and sending work again once ${name ?? "this app"} is available.`,
      appDownBlocked: ({ name }: Name) =>
        `${name ?? "This app"} is not available right now. This works again once ${name ?? "this app"} is available.`,
      appBack: ({ name }: Name) => `${name ?? "This app"} is available`,
      continue: "You can save and send again.",
      bypass: "Only you see the Cloud.",
      bypassEnded: "Everyone sees the Cloud again.",
      end: "End maintenance",
      ending: "Ending maintenance …",
      endFailed: "Maintenance is still on. Try again.",
    },
    de: {
      maintenance: "Wartungsmodus aktiv",
      maintenanceKeeps: "Deine Eingaben bleiben hier. Speichern und Senden ist nach der Wartung möglich.",
      maintenanceBlocked: "Wartungsmodus aktiv. Das geht wieder, sobald die Wartung beendet ist.",
      maintenanceEnded: "Wartung beendet",
      appUpdating: ({ name }: Name) => `${name ?? "Diese App"} wird gerade aktualisiert`,
      appUpdatingKeeps: "Deine Eingaben bleiben hier. Speichern und Senden ist nach der Aktualisierung möglich.",
      appUpdatingBlocked: ({ name }: Name) =>
        `${name ?? "Diese App"} wird gerade aktualisiert. Das geht wieder, sobald die Aktualisierung abgeschlossen ist.`,
      appUpdated: "Aktualisierung abgeschlossen",
      appDown: ({ name }: Name) => `${name ?? "Diese App"} ist gerade nicht erreichbar`,
      appDownKeeps: ({ name }: Name) =>
        `Deine Eingaben bleiben hier. Speichern und Senden ist möglich, sobald ${name ?? "diese App"} verfügbar ist.`,
      appDownBlocked: ({ name }: Name) =>
        `${name ?? "Diese App"} ist gerade nicht erreichbar. Das geht wieder, sobald ${name ?? "diese App"} verfügbar ist.`,
      appBack: ({ name }: Name) => `${name ?? "Diese App"} ist verfügbar`,
      continue: "Du kannst jetzt wieder speichern und senden.",
      bypass: "Nur du siehst die Cloud.",
      bypassEnded: "Alle sehen die Cloud wieder.",
      end: "Wartung beenden",
      ending: "Wartung wird beendet …",
      endFailed: "Die Wartung läuft noch. Versuch es noch einmal.",
    },
  },
});

export type MaintenanceNoticeMessages = ReturnType<(typeof maintenanceNoticeMessages)["resolve"]>["t"];
