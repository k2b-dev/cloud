const messages: Record<string, [string, string]> = {
  index_disabled: [
    "The index is disabled in this Filegate root configuration.",
    "Der Index ist in der Konfiguration dieses Filegate-Roots deaktiviert.",
  ],
  operation_busy: [
    "Another operation is running on this root. Try again shortly.",
    "Für diesen Root läuft bereits eine Aktion. Bitte gleich erneut versuchen.",
  ],
  operation_pending: [
    "A pending operation must be retried before this directory can be changed.",
    "Zuerst den ausstehenden Vorgang für dieses Verzeichnis erneut ausführen.",
  ],
  source_changed: [
    "The directory changed after the operation started. Check its current contents before retrying.",
    "Das Verzeichnis hat sich seit Beginn des Vorgangs geändert. Vor einem neuen Versuch den Bestand prüfen.",
  ],
  configuration_changed: [
    "The operation belongs to a different storage configuration. Restore that configuration before retrying.",
    "Der Vorgang gehört zu einer anderen Ablagenkonfiguration. Vor einem neuen Versuch diese Konfiguration wiederherstellen.",
  ],
  confirmation_mismatch: [
    "Enter the complete displayed path to confirm permanent deletion or restoration.",
    "Zur Bestätigung den vollständigen angezeigten Pfad eingeben.",
  ],
  archive_not_private: [
    "The archive container is not exclusively accessible to the Filegate service. Check ownership and permissions.",
    "Der Archivcontainer ist nicht ausschließlich für den Filegate-Dienst zugänglich. Eigentümer und Rechte prüfen.",
  ],
  path_conflict: [
    "The target path already exists. Existing contents were not replaced.",
    "Der Zielpfad existiert bereits. Vorhandene Inhalte wurden nicht ersetzt.",
  ],
  retired: [
    "This directory is retired or archived. Restore it explicitly before reusing it.",
    "Dieses Verzeichnis ist stillgelegt oder archiviert. Vor erneuter Nutzung ausdrücklich wiederherstellen.",
  ],
  identity_unknown: [
    "The authoritative identity could not be verified. Check the identity provider before retrying.",
    "Die maßgebliche Identität konnte nicht geprüft werden. Vor einem neuen Versuch den Identitätsanbieter prüfen.",
  ],

  local_linux_disabled: [
    "Enable local Linux identities before enabling Cloud files.",
    "Aktiviere lokale Linux-Identitäten, bevor du Cloud-Dateien aktivierst.",
  ],
  freeipa_disabled: ["Enable FreeIPA before enabling FreeIPA files.", "Aktiviere FreeIPA, bevor du FreeIPA-Dateien aktivierst."],
  invalid_configuration: ["Check the Filegate URL and storage configuration.", "Prüfe Filegate-URL und Ablagenkonfiguration."],
  invalid_path: [
    "Use a relative path without empty, parent or private segments.",
    "Verwende einen relativen Pfad ohne leere, übergeordnete oder private Abschnitte.",
  ],
  overlapping_paths: [
    "Home, group and archive paths must not overlap.",
    "Nutzer-, Gruppen- und Archivpfade dürfen sich nicht überschneiden.",
  ],
  overlapping_roots: ["Choose separate Filegate roots for Cloud and FreeIPA.", "Wähle getrennte Filegate-Roots für Cloud und FreeIPA."],
  not_configured: ["Configure the Filegate URL and token first.", "Konfiguriere zuerst Filegate-URL und Token."],
  editor_disabled: ["Document editing is not configured for this Cloud.", "Die Dokumentbearbeitung ist in dieser Cloud nicht konfiguriert."],
  editor_unsupported: ["This file type cannot be edited in the browser.", "Dieser Dateityp kann nicht im Browser bearbeitet werden."],
  editor_unavailable: ["The document editor is not reachable. Try again later.", "Der Dokumenteditor ist nicht erreichbar. Bitte später erneut versuchen."],
  archive_limited: [
    "This folder holds too many entries to check for a download. Download smaller folders instead.",
    "Dieser Ordner enthält zu viele Einträge für eine Download-Prüfung. Lade kleinere Ordner herunter.",
  ],
  favorites_full: ["You have reached the maximum number of favorites. Remove one first.", "Du hast die Höchstzahl an Favoriten erreicht. Entferne zuerst einen."],
  preview_unsupported: ["No preview is available for this file type.", "Für diesen Dateityp gibt es keine Vorschau."],
  preview_too_large: ["The file is too large for a preview.", "Die Datei ist für eine Vorschau zu groß."],
  inbox_busy: ["This inbox is receiving too many uploads at once. Try again in a moment.", "Dieser Eingang erhält gerade zu viele Uploads gleichzeitig. Bitte gleich erneut versuchen."],
  invalid_cursor: ["The page cursor is not valid. Start again from the first page.", "Der Seiten-Cursor ist ungültig. Beginne wieder bei der ersten Seite."],
  area_disabled: ["This storage area is disabled.", "Dieser Dateibereich ist deaktiviert."],
  forbidden: ["You do not have permission to read this path.", "Du hast keine Leseberechtigung für diesen Pfad."],
  reserved_path: [
    "This reserved path is not available in the file browser.",
    "Dieser reservierte Pfad ist im Dateibrowser nicht zugänglich.",
  ],
  identity_incomplete: ["The required Unix identity is incomplete.", "Die erforderliche Unix-Identität ist unvollständig."],
  binding_conflict: [
    "This path is already assigned to another identity or location.",
    "Dieser Pfad ist bereits einer anderen Identität oder einem anderen Speicherort zugeordnet.",
  ],
  ownership_mismatch: [
    "Directory ownership does not match the account's Unix identity.",
    "Die Verzeichnisrechte passen nicht zur Unix-Identität des Kontos.",
  ],
  unassigned: ["An administrator must assign this directory first.", "Die Administration muss dieses Verzeichnis zuerst zuordnen."],
  not_directory: ["The selected path is not a directory.", "Der ausgewählte Pfad ist kein Verzeichnis."],
  not_file: ["Select one file to download.", "Wähle eine einzelne Datei zum Herunterladen."],
  not_found: ["The requested path or identity was not found.", "Der angeforderte Pfad oder die Identität wurde nicht gefunden."],
  insufficient_space: ["The storage does not have enough free space for this file.", "Die Ablage hat nicht genug freien Speicherplatz für diese Datei."],
  upload_closed: ["This upload is no longer open. Start it again.", "Dieser Upload ist nicht mehr offen. Starte ihn erneut."],
  upload_incomplete: ["The upload has not transferred all data yet.", "Der Upload hat noch nicht alle Daten übertragen."],
  move_into_self: ["A folder cannot be moved or copied into itself.", "Ein Ordner kann nicht in sich selbst verschoben oder kopiert werden."],
  versioning_disabled: ["Versions are not enabled for this storage.", "Für diese Ablage sind Versionen nicht aktiviert."],
  search_limited: [
    "This folder holds too many entries to search without an index. Search within a smaller folder.",
    "Dieser Ordner enthält zu viele Einträge für eine Suche ohne Index. Suche in einem kleineren Ordner.",
  ],
};
export function errorMessage(code: string, locale: string): string {
  return (messages[code] ?? [
    "Storage is currently unavailable. Try again after checking the connection.",
    "Die Ablage ist derzeit nicht verfügbar. Bitte Verbindung prüfen und erneut versuchen.",
  ])[locale.startsWith("de") ? 1 : 0]!;
}
