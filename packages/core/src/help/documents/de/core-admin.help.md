---
id: core-admin
title: Administration
icon: ti ti-settings
description: Administrationsübersicht, Lebenszyklus von Ankündigungen und Core-Einstellungsgruppen.
order: 120
---

Die Core-Administrationsseiten konfigurieren Plattformdienste und verlinken die von Apps registrierten Administrationsbereiche.

Die Account-Einstellungen verlinken über **Dokumentation** die passende englische
Anleitung in einem neuen Tab. Unter **Allgemein** wählst du mit
**Dokumentationsadresse** die öffentliche Doku, einen eigenen Spiegel oder den
lokalen Fibel-Server. Das ändert nur Doku-Links, nicht die App-Anmeldung.
Die integrierte Hilfe bleibt davon unabhängig.

## Administrationsseiten {icon="user-cog"}

:::reference
- **Übersicht:** Listet registrierte Apps mit Administrationsbereichen und fasst registrierte Apps, verwaltbare Bereiche und sichtbare Navigationseinträge zusammen.
- **App-Zugänge:** Wähle eine Anwendung und erstelle einen benannten Zugang für Hintergrundarbeit zwischen Apps. Kopiere den einmalig angezeigten Token; danach sind nur Metadaten und Widerruf verfügbar. Nutzermandate begrenzen weiterhin die erlaubten Aktionen.
- **Ankündigungen:** Erstelle und bearbeite Ankündigungen oder Banner. Einträge können abhängig von Veröffentlichungs- und Ablaufzeit aktiv, geplant oder abgelaufen sein.
- **Einstellungen:** Bearbeite Einstellungen nach Gruppen. Jedes Feld zeigt seinen aktuellen Wert und, sofern vom Einstellungsdienst bereitgestellt, seine Quelle.
:::

## Einstellungsgruppen {icon="settings"}

Unter **Accounts & Anmeldung → Anmeldung** konfigurierst du **Guest**, passwortlose lokale
**Login**-Accounts und **FreeIPA** getrennt. Login lässt sich etwa in
**Firmenaccount** umbenennen. **Erlauben** steuert den Zugriff; **Im Login
anzeigen** nur die allgemeine Login-Seite. Verborgene, erlaubte Accounts können
direkte Links nutzen. Bei nur einem sichtbaren Typ entfällt die Auswahl.
Gast-Selbstregistrierung bleibt eine eigene Entscheidung.

Deaktivieren sperrt auch nachfolgende Anfragen bestehender Sitzungen,
benutzergebundener OAuth-Tokens, persönlicher API-Schlüssel und Hintergrundarbeit.
Es löscht keine Accounts und stoppt nicht den FreeIPA-Sync. Erneutes Erlauben
macht ansonsten gültige Zugangsdaten wieder nutzbar. Halte vor dem Sperren
deines eigenen Typs einen anderen erlaubten Admin-Zugang oder den Notfall-Token
bereit. Die Notfallwiederherstellung erlaubt nach ausdrücklicher Bestätigung
wieder alle lokalen Login-Accounts; die Login-Sichtbarkeit bleibt unverändert.

:::reference
- **Allgemein:** Branding, öffentliche Links und globale Zeitpläne.
- **Registrierung & Anfragen:** Gast-Selbstregistrierung, FreeIPA-Zugangsanfragen, Account-Vorgaben, Ablauf und Erinnerungen. Bei Neuinstallationen müssen Anfragen ausdrücklich aktiviert werden; Upgrades erhalten das bisherige Verhalten. Deaktivieren neuer Anfragen lässt bestehende Anfragen zur Bearbeitung verfügbar.
- **Hinweise zur Nacharbeit:** Unter Registrierung & Anfragen kannst du eine optionale Liquid-Markdown-Vorlage für Hinweise nach erfolgreichen Benutzer- und Gruppenänderungen hinterlegen. Wähle passende Aktionen über `action` und prüfe die Vorschau mit Beispieldaten. Leere Ausgabe zeigt keinen Hinweis. Die Hinweise richten sich an die ausführende Person, nicht als Nachricht an den betroffenen Nutzer. NFS-Anweisungen sind nicht mehr fest eingebaut.
- **Betrieb:** Öffne gefilterte Lifecycle- und FreeIPA-Sync-Protokolle oder geplante Aufträge. Die Nachpflege ändert Ablaufdaten, keine Linux-Identitäten, und kann den Zugang abgelaufener Accounts wiederherstellen. Ein Toast bestätigt die Beauftragung; den Abschluss prüfst du in den Protokollen. Einzelne Datensätze und Anfragen bleiben in Accounts.
- **Linux-Identitäten:** Reserviere einen ID-Bereich und lege Home- und Shell-Standardwerte fest. Bei aktivierter Vergabe erhalten neue lokale Vollaccounts und hochgestufte Gäste ihre Linux-Attribute automatisch. Nutze **Backfill bestehender Accounts** für ältere Vollaccounts; das Aktivieren ändert sie nicht. Deaktivieren blendet die Backfill-Tabelle aus und erhält bestehende Identitäten in Accounts. Dies aktiviert weder Rechneranmeldung noch sudo.
- **FreeIPA:** FreeIPA-Verbindungseinstellungen, Synchronisierungsregeln und Gruppenzuordnung.
- **AI:** Konfiguriere Modellprofile und Anbieterzugangsdaten, prüfe Hintergrundarbeit und nutze **Skills** oder **Projects**, um den Zugriff wiederherzustellen, wenn eine gemeinsam genutzte Ressource keine Person mit Administratorrechten mehr hat. Diese Wiederherstellungsseiten können Berechtigungen vergeben oder nicht mehr benötigte Ressourcen dauerhaft löschen, einschließlich der ursprünglich von Cloud bereitgestellten Skills.
- **Mail und PDF-Rendering:** Konfiguriere SMTP-Zustellung, Absenderzugangsdaten, Gotenberg-Verbindung, Zugangsdaten und Rendergrenzen.
- **Vorlagen, Sicherheit und Rechtliches:** Transaktionale E-Mail-Vorlagen, Ratenbegrenzungen, Standards für den Zugriffsschutz, Nutzungsbedingungen, Datenschutzerklärung und Impressum.
:::

## Erster Administratorzugang {icon="key"}

Für eine neue Instanz hinterlegt der Betreiber vorübergehend `ADMIN_LOGIN_TOKEN`
ausschließlich in Core. Öffne `/auth/login?method=admin` und gib ihn ein.
Prüfe und akzeptiere die angezeigten rechtlichen Dokumente, um die erste Anmeldung
abzuschließen.
Richte die reguläre Admin-Anmeldung ein und prüfe sie. Danach entfernt der
Betreiber den Token und startet Core neu. FreeIPA und die Admin-Gruppenzuordnung
werden in den Einstellungen eingerichtet; es gibt keinen FreeIPA-Env-Bootstrap.

## App-Zugang rotieren {icon="key"}

Erstelle unter **App-Zugänge** einen neuen Zugang, bei Bedarf mit Ablaufzeit.
Hinterlege ihn über die Secret-Verwaltung des Deployments ausschließlich in der
zugehörigen App als `CLOUD_APP_CREDENTIAL`. Hintergrundaufrufe benötigen außerdem
Cores interne Adresse in `CLOUD_CORE_INTERNAL_ORIGIN`. Prüfe nach der Übernahme
die Hintergrundarbeit und widerrufe anschließend den alten Zugang. Der Widerruf
stoppt neue Aufrufe mit diesem Zugang.
