import type { SettingFieldDef } from "./CoreSettingsForm.island";

type SettingCopy = Pick<SettingFieldDef, "label" | "description"> & { placeholder?: string };

const deOptions: Partial<Record<string, Record<string, string>>> = {
  "freeipa.user_match_mode": {
    ignore: "Lokales Konto ignorieren",
    migrate: "Passendes lokales Konto migrieren",
  },
  "freeipa.account_transition_policy": {
    delete: "Konto löschen",
    demote_to_local: "In lokales Konto umwandeln (Profil behalten)",
    demote_to_local_guest: "In lokales Gastkonto umwandeln",
    demote_to_local_user: "In lokales Benutzerkonto umwandeln",
  },
};

const de: Record<string, SettingCopy> = {
  "user.account_requests.enabled": {
    label: "Account-Anfragen erlauben",
    description:
      "Lokale Accounts dürfen FreeIPA-Zugang beantragen. FreeIPA-Zugang muss erlaubt sein. Bestehende Anfragen bleiben nach dem Deaktivieren bearbeitbar.",
  },
  "user.action_notice": {
    label: "Hinweis nach Account- oder Gruppenänderungen",
    description:
      "Optionale Liquid-Markdown-Vorlage für die ausführende Person, keine Benutzerbenachrichtigung. Nach action unterscheiden, etwa user.create oder group.delete. Leere Ausgabe zeigt keinen Hinweis. Nur der dokumentierte Kontext ohne Zugangsdaten ist verfügbar.",
  },
  "user.app_approval.enabled": {
    label: "App-Anmeldung aktivieren",
    description:
      "Zeigt die Einrichtung unter Sicherheit. Kopplung und Anmeldung benötigen zusätzlich eine gültige App-Adresse. Aktiviert keinen Linux-Login und ersetzt keine bisherigen Anmeldemethoden.",
  },
  "user.app_approval.origin": {
    label: "Adresse der App-Website (Origin)",
    description:
      "Vertrauenswürdige HTTPS-Origin der separat gehosteten App, ohne Pfad. Bei einem Wechsel bestehende Geräte prüfen und bei Bedarf widerrufen. Keine Wildcards.",
  },
  "user.app_approval.admin_pairing": {
    label: "Administratoren dürfen bei der Kopplung helfen",
    description:
      "Frisch angemeldete Administratoren dürfen Geräte für andere Accounts koppeln. Die Kopplung verlangt eine ausdrückliche Bestätigung und wird protokolliert.",
  },
  "user.category.guest.enabled": {
    label: "Guest-Accounts erlauben",
    description:
      "Anmeldung und benutzergebundene Zugänge für lokale Gastaccounts erlauben. Bestehende Accounts und Daten bleiben beim Deaktivieren erhalten.",
  },
  "user.category.guest.visible": {
    label: "Guest im Login anzeigen",
    description: "Verborgene, erlaubte Accounts können direkte Login-Links nutzen. Dies aktiviert keine Selbstregistrierung.",
  },
  "user.category.login.enabled": {
    label: "Lokale Vollaccounts erlauben",
    description: "Anmeldung und benutzergebundene Zugänge für passwortlose lokale Vollaccounts erlauben.",
  },
  "user.category.login.visible": {
    label: "Im Login anzeigen",
    description: "Diesen Accounttyp auf der allgemeinen Login-Seite anbieten. Direkte Links funktionieren auch bei ausgeblendeter Auswahl.",
  },
  "user.category.login.label": {
    label: "Anzeigename",
    description: "Name für lokale Vollaccounts, z. B. Firmenaccount. Leer verwendet Login.",
  },
  "user.category.freeipa.enabled": {
    label: "FreeIPA-Accounts erlauben",
    description:
      "Anmeldung und benutzergebundene Zugänge für FreeIPA-Accounts erlauben. Die Verzeichnissynchronisierung bleibt unverändert.",
  },
  "user.category.freeipa.visible": {
    label: "FreeIPA im Login anzeigen",
    description: "Für diese Anmeldung muss auch die FreeIPA-Verbindung aktiviert sein.",
  },
  "app.url": {
    label: "Öffentliche URL",
    description: "Öffentliche App-URL für Links in E-Mails, OAuth-Weiterleitungen und WebSocket-Verbindungen.",
  },
  "app.documentation_url": {
    label: "Dokumentationsadresse",
    description: "Basisadresse für Doku-Links in der Administration. Eigener Cloud-Doku-Spiegel oder lokaler Fibel-Server; unabhängig von der App-Anmeldung.",
  },
  "app.home_path": {
    label: "Startpfad",
    description:
      "Lokaler Pfad nach der Anmeldung und beim Aufruf der Cloud-Wurzel. Er muss für alle angemeldeten Benutzer erreichbar sein.",
  },
  "app.name": { label: "Name", description: "Anzeigename der Anwendung." },
  "app.contact_email": { label: "Kontaktadresse", description: "E-Mail-Adresse für Supportanfragen." },
  "app.copyright": { label: "Urheberhinweis", description: "Name des Rechteinhabers in der Fußzeile." },
  "app.logo": { label: "Logo", description: "Logo der Anwendung." },
  "app.favicon": { label: "Favicon", description: "Symbol für Browser-Tabs und Lesezeichen." },
  "app.locale": {
    label: "Standardsprache",
    description:
      "BCP-47-Sprache für Anfragen ohne eigene Präferenz. Sie steuert Dokumentensprache, Formatierung und Übersetzungskataloge der Apps.",
  },
  "app.timezone": { label: "Zeitzone", description: "IANA-Zeitzone für geplante Aufgaben und zeitabhängige Abläufe." },
  "app.cleanup_schedule": {
    label: "Bereinigungszeitplan",
    description: "Cron-Ausdruck mit fünf Feldern für automatische Bereinigungen in der eingestellten Zeitzone.",
  },
  "gotenberg.url": { label: "Gotenberg-URL", description: "Interne Basis-URL des Gotenberg-Dienstes für HTML-zu-PDF." },
  "gotenberg.username": { label: "Basic-Auth-Benutzername", description: "Optionaler Benutzername für Gotenberg Basic Auth." },
  "gotenberg.password": { label: "Basic-Auth-Passwort", description: "Optionales Passwort für Gotenberg Basic Auth." },
  "gotenberg.timeout_ms": { label: "Zeitlimit", description: "Maximale Dauer einer Gotenberg-Anfrage in Millisekunden." },
  "gotenberg.max_html_bytes": {
    label: "Maximale HTML-Größe",
    description: "Maximale Größe der HTML-Eingabe vor dem Versand an Gotenberg.",
  },
  "gotenberg.max_pdf_bytes": { label: "Maximale PDF-Größe", description: "Maximale Größe einer von Gotenberg angenommenen PDF-Ausgabe." },
  "freeipa.enable": {
    label: "FreeIPA aktivieren",
    description: "Aktiviert FreeIPA-Anmeldung, Synchronisierung, Kontoverwaltung und IPA-Gruppen.",
  },
  "freeipa.url": { label: "Server-Host", description: "FreeIPA-Hostname für RPC- und Anmeldeanfragen ohne Protokoll." },
  "freeipa.ca_cert": {
    label: "CA-Zertifikat (PEM)",
    description: "FreeIPA-Root-CA im PEM-Format für selbst signierte oder private Zertifizierungsstellen.",
  },
  "freeipa.allow_insecure": {
    label: "Unsicheres TLS erlauben",
    description: "Deaktiviert die Zertifikatsprüfung vollständig. Nur für lokale Entwicklung verwenden.",
  },
  "freeipa.service_user": { label: "Dienstkonto", description: "FreeIPA-Benutzername für interne Verwaltungsaufgaben." },
  "freeipa.service_password": { label: "Passwort des Dienstkontos", description: "FreeIPA-Passwort für interne Verwaltungsaufgaben." },
  "freeipa.groups.admin": {
    label: "Administrationsgruppen",
    description: "FreeIPA-Gruppen, die Administrationszugriff auf Apps gewähren.",
  },
  "freeipa.groups.base_sync": {
    label: "Basisgruppen für die Synchronisierung",
    description:
      "Erforderliche FreeIPA-Gruppen, deren Mitglieder überhaupt ein Cloud-Konto erhalten. Leer lassen verhindert eine ungewollte Synchronisierung des gesamten Verzeichnisses.",
  },
  "freeipa.groups.base_ipa_realm": {
    label: "Basisgruppen für vollständige Konten",
    description: "Erforderliche FreeIPA-Gruppen für vollständige Konten. Andere Mitglieder im Synchronisierungsbereich werden Gäste.",
  },
  "freeipa.groups.excluded": {
    label: "Ausgeschlossene Gruppen",
    description: "FreeIPA-Gruppen, die nicht in Mitgliedschaften und Hierarchien gespiegelt werden.",
  },
  "freeipa.user_match_mode": {
    label: "Abgleich lokaler Konten",
    description: "Bestimmt, wie die IPA-Synchronisierung ein eindeutiges lokales Konto mit gleicher E-Mail-Adresse behandelt.",
  },
  "freeipa.account_transition_policy": {
    label: "Richtlinie für Kontoübergänge",
    description: "Bestimmt, was mit IPA-Konten geschieht, die ablaufen oder den Synchronisierungsbereich verlassen.",
  },
  "freeipa.sync_cron": {
    label: "Synchronisierungszeitplan",
    description: "Cron-Ausdruck mit fünf Feldern für die FreeIPA-Synchronisierung.",
  },
  "freeipa.sync_guard.max_user_changes": {
    label: "Maximale Kontoänderungen",
    description:
      "Maximale Anzahl von Konten, die ein Lauf aus dem Bereich entfernen oder herabstufen darf. Null blockiert alle destruktiven Änderungen.",
  },
  "freeipa.sync_guard.max_user_change_percent": {
    label: "Maximaler Anteil geänderter Konten",
    description: "Maximaler prozentualer Anteil bestehender IPA-Konten, die ein Lauf entfernen oder herabstufen darf.",
  },
  "freeipa.sync_guard.max_group_deletions": {
    label: "Maximale Gruppenlöschungen",
    description: "Maximale Anzahl gespiegelter IPA-Gruppen, die ein Lauf löschen darf. Null blockiert alle Löschungen.",
  },
  "freeipa.sync_guard.max_group_deletion_percent": {
    label: "Maximaler Anteil gelöschter Gruppen",
    description: "Maximaler prozentualer Anteil bestehender IPA-Gruppen, die ein Lauf löschen darf.",
  },
  "user.allow_self_registration": {
    label: "Selbstregistrierung erlauben",
    description: "Erstellt bei der ersten E-Mail-Anmeldung automatisch ein lokales Gastkonto, wenn noch kein Konto vorhanden ist.",
  },
  "user.abbr_length": { label: "Länge der Benutzerkürzel", description: "Länge zufällig erzeugter Benutzerkürzel für neue Konten." },
  "user.session.expiry_hours": { label: "Sitzungsdauer in Stunden", description: "Dauer, für die eine Anmeldung gültig bleibt." },
  "user.account.ipa_expires_days": {
    label: "Gültigkeit von IPA-Konten",
    description: "Tage bis zum Ablauf eines IPA-Kontos. Null bedeutet ohne Ablaufdatum.",
  },
  "user.account.local_user_expires_days": {
    label: "Gültigkeit lokaler Konten",
    description: "Tage bis zum Ablauf eines lokalen Benutzerkontos. Null bedeutet ohne Ablaufdatum.",
  },
  "user.account.local_guest_expires_days": {
    label: "Gültigkeit lokaler Gastkonten",
    description: "Tage bis zum Ablauf eines lokalen Gastkontos. Null bedeutet ohne Ablaufdatum.",
  },
  "user.account.reminder_days": { label: "Erinnerungstage", description: "Tage vor dem Ablauf, an denen Erinnerungen gesendet werden." },
  "user.account.reminder_cron": {
    label: "Erinnerungszeitplan",
    description: "Cron-Ausdruck mit fünf Feldern für Erinnerungen an ablaufende Konten.",
  },
  "user.account.deleted_accounts_retention_days": {
    label: "Aufbewahrung gelöschter Konten",
    description: "Tage bis zur Bereinigung der Historie gelöschter Konten. Null bedeutet dauerhaft aufbewahren.",
  },
  "user.account.reminder_history_retention_days": {
    label: "Aufbewahrung der Erinnerungshistorie",
    description: "Tage bis zur Bereinigung der Erinnerungshistorie. Null bedeutet dauerhaft aufbewahren.",
  },
  "mail.user_welcome_freeipa": {
    label: "Willkommensvorlage für FreeIPA",
    description: "HTML-Vorlage der Willkommensmail für FreeIPA-Konten.",
  },
  "mail.user_welcome_local": {
    label: "Willkommensvorlage für lokale Konten",
    description: "HTML-Vorlage der Willkommensmail für lokale Konten.",
  },
  "mail.magic_link_login": { label: "Vorlage für Anmeldelinks", description: "HTML-Vorlage der E-Mail mit Anmeldecode und Anmeldelink." },
  "mail.ipa_email_login_hint": {
    label: "Hinweisvorlage für FreeIPA-Anmeldungen",
    description: "HTML-Vorlage des Hinweises, wenn eine E-Mail-Adresse zu einem FreeIPA-Konto gehört.",
  },
  "mail.password_reset": {
    label: "Vorlage zum Zurücksetzen des Passworts",
    description: "HTML-Vorlage der E-Mail zum Zurücksetzen des Passworts.",
  },
  "mail.account_expiry_reminder": {
    label: "Vorlage für Ablauferinnerungen",
    description: "HTML-Vorlage der Erinnerung an ein ablaufendes Konto.",
  },
  "mail.account_request_denial": {
    label: "Vorlage für abgelehnte Kontoanträge",
    description: "HTML-Vorlage der E-Mail bei einem abgelehnten Kontoantrag.",
  },
  "mail.noreply.smtp_host": { label: "SMTP-Host", description: "Hostname des SMTP-Servers." },
  "mail.noreply.smtp_port": { label: "SMTP-Port", description: "Port des SMTP-Servers, üblicherweise 587 für STARTTLS oder 465 für SSL." },
  "mail.noreply.from": { label: "Absenderadresse", description: "E-Mail-Adresse des Absenders." },
  "mail.noreply.user": { label: "SMTP-Benutzername", description: "Benutzername für den SMTP-Server." },
  "mail.noreply.password": { label: "SMTP-Passwort", description: "Passwort für den SMTP-Server." },
  "security.rate_limit_per_second": {
    label: "Anfragen pro Sekunde",
    description: "Maximale Anzahl von API-Anfragen pro Sekunde und IP-Adresse.",
  },
};

export const localizeSettingField = (entry: SettingFieldDef, locale: string): SettingFieldDef => {
  if (!locale.toLowerCase().startsWith("de")) return entry;
  const copy = de[entry.key];
  const optionLabels = deOptions[entry.key];
  if (!copy && !optionLabels) return entry;
  return {
    ...entry,
    ...copy,
    options: entry.options?.map((option) => ({ ...option, label: optionLabels?.[option.value] ?? option.label })),
  };
};
