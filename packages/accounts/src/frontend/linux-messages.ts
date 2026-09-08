import { i18n } from "@k2b/stdlib";

export const linuxAccountMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      identity_conflict: "Conflicting or invalid Linux IDs/names. Review the identity data before using it.",
      title: "Linux identity",
      description: "Identity data only. Computer login and sudo are not enabled by this feature.",
      managedIpa: "Managed by FreeIPA. Cloud does not override these values.",
      managedLocal: "Managed by Cloud. Numeric IDs stay fixed, including after disabling assignment.",
      disabled: "Local identity assignment is disabled. Existing values are retained.",
      incomplete: "Some FreeIPA attributes are missing. Run the existing IPA synchronization to complete this projection.",
      sourceChanged:
        "The account provider has changed. The existing identity is retained; review a deliberate identity migration before using it.",
      guest: "Guest accounts do not receive Linux attributes. Any earlier identity remains reserved and does not grant access.",
      uid: "Numeric user ID",
      gid: "Primary group ID",
      home: "Home directory",
      shell: "Login shell",
      missing: "Not supplied",
      prepare: "Assign missing Linux attributes",
      edit: "Edit home and shell",
      save: "Save identity values",
      cancel: "Cancel",
      settings: "Global Linux settings",
      saved: "Identity values saved.",
      confirm: "Create stable user and group IDs with the configured defaults? This creates no files and enables no computer login.",
      confirmPaths:
        "Save these home and shell values? Existing directories are not moved. Check that the paths are suitable for your computers.",
      pathsHint: "Changes affect this identity only. Directories are not created or moved; the shell must exist on the target computers.",
      prepareGroup: "Assign Linux group ID",
      groupDescription: "Assign a stable GID to this group. This does not grant sudo or computer login.",
      groupConfirm: "Assign a permanent Linux group ID from the configured range? Members and permissions stay unchanged.",
      error: "The action could not be completed. Refresh the page and check the Linux setup before retrying.",
      invalid_name: "The name must use lowercase Linux-compatible characters and be at most 32 characters long.",
      group_conflict: "A group already uses this name. Resolve the name conflict before assigning the identity.",
      ipa_inventory_unavailable:
        "FreeIPA ID ranges could not be checked. Verify the connection and service account access in Administration.",
      ipa_range_conflict: "The configured range overlaps FreeIPA. Choose a different reserved range in Administration.",
      range_exhausted: "No IDs remain in the configured range. Review Linux settings in Administration.",
      setup_disabled: "Local identity assignment has been disabled. Refresh the page.",
      invalid_paths: "Enter absolute paths without spaces, colons or relative segments.",
      identity_not_locally_managed: "Only a Cloud-managed full account identity can be changed here.",
      provider_changed: "The provider changed. Review the identity migration before continuing.",
    },
    de: {
      identity_conflict: "Widersprüchliche oder ungültige Linux-IDs/Namen. Prüfe die Identitätsdaten vor ihrer Nutzung.",
      title: "Linux-Identität",
      description: "Nur Identitätsdaten. Diese Funktion aktiviert weder Rechneranmeldung noch sudo.",
      managedIpa: "Durch FreeIPA verwaltet. Cloud überschreibt diese Werte nicht.",
      managedLocal: "Durch Cloud verwaltet. Numerische IDs bleiben fest, auch nach Deaktivierung der Vergabe.",
      disabled: "Die Vergabe lokaler Identitäten ist deaktiviert. Bestehende Werte bleiben erhalten.",
      incomplete: "Einige FreeIPA-Attribute fehlen. Führe die bestehende IPA-Synchronisierung aus, um die Ansicht zu vervollständigen.",
      sourceChanged:
        "Der Accountprovider wurde geändert. Die bestehende Identität bleibt erhalten; prüfe vor ihrer Nutzung eine gezielte Identitätsmigration.",
      guest: "Gastkonten erhalten keine Linux-Attribute. Eine frühere Identität bleibt reserviert und gewährt keinen Zugang.",
      uid: "Numerische Benutzer-ID",
      gid: "Primäre Gruppen-ID",
      home: "Home-Verzeichnis",
      shell: "Login-Shell",
      missing: "Nicht geliefert",
      prepare: "Fehlende Linux-Attribute ergänzen",
      edit: "Home und Shell bearbeiten",
      save: "Identitätswerte speichern",
      cancel: "Abbrechen",
      settings: "Globale Linux-Einstellungen",
      saved: "Identitätswerte gespeichert.",
      confirm:
        "Stabile Benutzer- und Gruppen-IDs mit den eingestellten Standardwerten anlegen? Es werden keine Dateien angelegt und keine Rechneranmeldung aktiviert.",
      confirmPaths:
        "Diese Home- und Shell-Werte speichern? Bestehende Verzeichnisse werden nicht verschoben. Prüfe, ob die Pfade für deine Rechner geeignet sind.",
      pathsHint:
        "Änderungen gelten nur für diese Identität. Verzeichnisse werden nicht angelegt oder verschoben; die Shell muss auf den Zielrechnern vorhanden sein.",
      prepareGroup: "Linux-Gruppen-ID vergeben",
      groupDescription: "Dieser Gruppe eine stabile GID zuweisen. Dies gewährt weder sudo noch Rechnerzugang.",
      groupConfirm:
        "Eine dauerhafte Linux-Gruppen-ID aus dem eingestellten Bereich vergeben? Mitglieder und Berechtigungen bleiben unverändert.",
      error:
        "Die Aktion konnte nicht abgeschlossen werden. Aktualisiere die Seite und prüfe die Linux-Einrichtung vor einem erneuten Versuch.",
      invalid_name: "Der Name muss Linux-kompatible Kleinbuchstaben verwenden und darf höchstens 32 Zeichen lang sein.",
      group_conflict: "Eine Gruppe verwendet diesen Namen bereits. Behebe den Namenskonflikt vor der Vergabe.",
      ipa_inventory_unavailable:
        "FreeIPA-ID-Bereiche konnten nicht geprüft werden. Prüfe Verbindung und Dienstaccountrechte in der Administration.",
      ipa_range_conflict:
        "Der konfigurierte Bereich überschneidet sich mit FreeIPA. Wähle einen anderen reservierten Bereich in der Administration.",
      range_exhausted: "Im eingestellten Bereich sind keine IDs mehr frei. Prüfe die Linux-Einstellungen in der Administration.",
      setup_disabled: "Die Vergabe lokaler Identitäten wurde deaktiviert. Aktualisiere die Seite.",
      invalid_paths: "Gib absolute Pfade ohne Leerzeichen, Doppelpunkte oder relative Segmente ein.",
      identity_not_locally_managed: "Hier kann nur die Cloud-verwaltete Identität eines Vollaccounts geändert werden.",
      provider_changed: "Der Provider wurde geändert. Prüfe die Identitätsmigration, bevor du fortfährst.",
    },
  },
});

export const accountLinuxError = async (response: Response, t: ReturnType<typeof linuxAccountMessages.resolve>["t"]): Promise<Error> => {
  const body: unknown = await response.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body ? body.code : null;
  const message = Object.entries(t).find(([key]) => key === code)?.[1];
  return new Error(typeof message === "string" ? message : t.error);
};
