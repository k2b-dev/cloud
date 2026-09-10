import { i18n } from "@k2b/stdlib";
export const databaseMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Shared database",
      enabled: "Use a shared database",
      shared: "Data is stored on the server and shared with everyone who can use this app.",
      globalOff: "Shared databases are disabled for this Cloud instance. A Cloud administrator must enable the feature first.",
      disabled: "Database access is disabled. Existing data is kept.",
      preparing: "Preparing the database. Refresh to check its status.",
      unavailable: "The database is currently unavailable. Try again later.",
      stale: "The database changed. Restart this tool before continuing.",
      configured: "Configure the rsql server and token first.",
      inUse:
        "Existing databases or pending cleanup still use this server. Migrate them before changing the address or removing its credentials.",
      sql: "This SQL is outside the supported SELECT subset.",
      limit: "The request or result is too large. Use smaller batches or pagination.",
      invalid: "Check the database input and column values.",
      denied: "You do not have permission for this database operation.",
      request: "The database request failed. A write may already have completed; it was not repeated automatically.",
      tables: "Tables",
      records: "Records",
      storage: "Storage",
      refresh: "Refresh",
      export: "Export database",
      reset: "Reset database",
      resetConfirm: "Delete all tables and records in this app database? This cannot be undone. Scripts will need to be restarted.",
      save: "Save",
      cancel: "Cancel",
      close: "Dismiss notification",
      server: "rsql server URL",
      token: "API token",
      tokenHint: "Leave empty to keep the existing token.",
      tokenPresent: "A token is configured.",
      tokenMissing: "No token is configured.",
      tokenRemove: "Remove token",
      tokenRemoveConfirm:
        "Remove the saved token and disable shared databases? This is only possible when no databases or pending deletions depend on it.",
      feature: "Enable shared databases",
      test: "Test connection",
      connected: "Connection successful",
      settings: "Settings",
      apps: "Kit apps",
      actionsFor: ({ name }: { name: string }) => `Actions for ${name}`,
      appActions: "App actions",
      manageAccess: "Manage who can view, use, or edit this app.",
      accessLoadFailed: "Could not load app permissions.",
      accessRefreshFailed: "The change was saved, but permissions could not be reloaded.",
      orphaned: "Without an administrator",
      cleanup: "Pending database deletions",
      permissions: "Permissions",
      search: "Search apps",
      remove: "Delete app",
      deleteConfirm:
        "Delete this app and its shared database? Database cleanup will be retried if the server is unavailable. Local browser data cannot be removed remotely.",
      empty: "No apps found",
      status: "Status",
      updated: "Last checked",
      import: "Import",
      importing: "Importing records",
      done: "Import completed",
      stopped: "Import stopped; confirmed batches were kept.",
      failed: "Import interrupted; confirmed batches were kept. The last batch may already have been written. Do not repeat it blindly.",
      validating: "Validating records",
      count: ({ done, total }: { done: number; total: number }) => `${done} / ${total} records confirmed`,
      ready: "Ready",
      noDatabase: "No database created yet",
      unknown: "Not available",
    },
    de: {
      title: "Gemeinsame Datenbank",
      enabled: "Gemeinsame Datenbank verwenden",
      shared: "Daten werden auf dem Server gespeichert und mit allen Nutzern dieser App geteilt.",
      globalOff:
        "Gemeinsame Datenbanken sind für diese Cloud-Instanz deaktiviert. Ein Cloud-Administrator muss die Funktion zuerst aktivieren.",
      disabled: "Datenbankzugriff deaktiviert. Vorhandene Daten bleiben erhalten.",
      preparing: "Die Datenbank wird vorbereitet. Aktualisiere den Status.",
      unavailable: "Die Datenbank ist gerade nicht erreichbar. Versuche es später erneut.",
      stale: "Die Datenbank wurde geändert. Starte das Werkzeug neu, bevor du fortfährst.",
      configured: "Konfiguriere zuerst den rsql-Server und das Token.",
      inUse:
        "Vorhandene Datenbanken oder ausstehende Löschungen verwenden diesen Server. Migriere sie vor dem Ändern der Adresse oder Entfernen der Zugangsdaten.",
      sql: "Diese SQL-Abfrage liegt außerhalb des unterstützten SELECT-Umfangs.",
      limit: "Anfrage oder Ergebnis ist zu groß. Verwende kleinere Batches oder Seitennavigation.",
      invalid: "Prüfe die Datenbank-Eingaben und Spaltenwerte.",
      denied: "Dir fehlt die Berechtigung für diese Datenbank-Aktion.",
      request:
        "Die Datenbank-Anfrage ist fehlgeschlagen. Ein Schreibvorgang kann bereits abgeschlossen sein; er wurde nicht automatisch wiederholt.",
      tables: "Tabellen",
      records: "Datensätze",
      storage: "Speicher",
      refresh: "Aktualisieren",
      export: "Datenbank exportieren",
      reset: "Datenbank zurücksetzen",
      resetConfirm:
        "Alle Tabellen und Datensätze dieser App-Datenbank löschen? Dies lässt sich nicht rückgängig machen. Scripts müssen danach neu gestartet werden.",
      save: "Speichern",
      cancel: "Abbrechen",
      close: "Benachrichtigung schließen",
      server: "rsql-Serveradresse",
      token: "API-Token",
      tokenHint: "Leer lassen, um das vorhandene Token zu behalten.",
      tokenPresent: "Ein Token ist hinterlegt.",
      tokenMissing: "Kein Token hinterlegt.",
      tokenRemove: "Token entfernen",
      tokenRemoveConfirm:
        "Das gespeicherte Token entfernen und gemeinsame Datenbanken deaktivieren? Das ist nur möglich, wenn keine Datenbanken oder ausstehenden Löschungen davon abhängen.",
      feature: "Gemeinsame Datenbanken aktivieren",
      test: "Verbindung prüfen",
      connected: "Verbindung erfolgreich",
      settings: "Einstellungen",
      actionsFor: ({ name }) => `Aktionen für ${name}`,
      appActions: "App-Aktionen",
      manageAccess: "Verwalte, wer diese App ansehen, benutzen oder bearbeiten darf.",
      accessLoadFailed: "Die App-Berechtigungen konnten nicht geladen werden.",
      accessRefreshFailed: "Die Änderung wurde gespeichert, aber die Berechtigungen konnten nicht neu geladen werden.",
      apps: "Kit-Apps",
      orphaned: "Ohne Administrator",
      cleanup: "Ausstehende Datenbank-Löschungen",
      permissions: "Berechtigungen",
      search: "Apps suchen",
      remove: "App löschen",
      deleteConfirm:
        "Diese App und ihre gemeinsame Datenbank löschen? Bei einem Serverausfall wird die Bereinigung erneut versucht. Lokale Browserdaten können nicht aus der Ferne gelöscht werden.",
      empty: "Keine Apps gefunden",
      status: "Status",
      updated: "Zuletzt geprüft",
      import: "Import",
      importing: "Datensätze importieren",
      done: "Import abgeschlossen",
      stopped: "Import gestoppt; bestätigte Batches bleiben erhalten.",
      failed:
        "Import unterbrochen; bestätigte Batches bleiben erhalten. Der letzte Batch kann bereits geschrieben sein. Wiederhole ihn nicht ungeprüft.",
      validating: "Datensätze prüfen",
      count: ({ done, total }: { done: number; total: number }) => `${done} / ${total} Datensätze bestätigt`,
      ready: "Bereit",
      noDatabase: "Noch keine Datenbank angelegt",
      unknown: "Nicht verfügbar",
    },
  },
});
export function databaseErrorMessage(code: string, locale: string) {
  const t = databaseMessages.resolve([locale]).t;
  switch (code) {
    case "DB_GLOBALLY_DISABLED":
      return t.globalOff;
    case "DB_DISABLED":
      return t.disabled;
    case "DB_TRANSITION":
      return t.preparing;
    case "DB_STALE":
      return t.stale;
    case "DB_NOT_CONFIGURED":
      return t.configured;
    case "DB_SERVER_IN_USE":
      return t.inUse;
    case "DB_SQL_UNSUPPORTED":
      return t.sql;
    case "DB_LIMIT":
    case "quota_exceeded":
      return t.limit;
    case "ACCESS_DENIED":
      return t.denied;
    case "INVALID_INPUT":
    case "validation_failed":
      return t.invalid;
    default:
      return t.request;
  }
}
