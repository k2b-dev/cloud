const messages: Record<string, [string, string]> = {
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
};
export function errorMessage(code: string, locale: string): string {
  return (messages[code] ?? [
    "Storage is currently unavailable. Try again or contact your administrator.",
    "Die Ablage ist derzeit nicht verfügbar. Bitte erneut versuchen oder die Administration kontaktieren.",
  ])[locale.startsWith("de") ? 1 : 0]!;
}
