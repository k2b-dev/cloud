---
id: core-admin
title: Administration
icon: ti ti-settings
description: Administrationsübersicht, Lebenszyklus von Ankündigungen und Core-Einstellungsgruppen.
order: 120
---

Die Core-Administrationsseiten konfigurieren Plattformdienste und verlinken die von Apps registrierten Administrationsbereiche.

## Administrationsseiten {icon="user-cog"}

:::reference
- **Übersicht:** Listet registrierte Apps mit Administrationsbereichen und fasst registrierte Apps, verwaltbare Bereiche und sichtbare Navigationseinträge zusammen.
- **Ankündigungen:** Erstelle und bearbeite Ankündigungen oder Banner. Einträge können abhängig von Veröffentlichungs- und Ablaufzeit aktiv, geplant oder abgelaufen sein.
- **Einstellungen:** Bearbeite Einstellungen nach Gruppen. Jedes Feld zeigt seinen aktuellen Wert und, sofern vom Einstellungsdienst bereitgestellt, seine Quelle.
:::

## Einstellungsgruppen {icon="settings"}

Unter **Accounts & Anmeldung** konfigurierst du **Guest**, passwortlose lokale
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
- **Allgemein und Accounts & Anmeldung:** Branding, öffentliche Links, Zeitpläne, Vorgaben, Anmeldeverhalten, Ablauf, Erinnerungen und Selbstverwaltung.
- **Linux-Zugang:** Reserviere einen ID-Bereich und lege Home- und Shell-Standardwerte fest. Bei aktivierter Vergabe erhalten neue lokale Vollaccounts und hochgestufte Gäste ihre Linux-Attribute automatisch. Nutze **Backfill bestehender Accounts** für ältere Vollaccounts; das Aktivieren ändert sie nicht. Deaktivieren blendet die Backfill-Tabelle aus und erhält bestehende Identitäten in Accounts. Dies aktiviert weder Rechneranmeldung noch sudo.
- **FreeIPA:** FreeIPA-Verbindungseinstellungen, Synchronisierungsregeln und Gruppenzuordnung.
- **AI:** Konfiguriere Modellprofile und Anbieterzugangsdaten, prüfe Hintergrundarbeit und nutze **Skills** oder **Projects**, um den Zugriff wiederherzustellen, wenn eine gemeinsam genutzte Ressource keine Person mit Administratorrechten mehr hat. Diese Wiederherstellungsseiten können Berechtigungen vergeben oder nicht mehr benötigte Ressourcen dauerhaft löschen, einschließlich der ursprünglich von Cloud bereitgestellten Skills.
- **Mail und PDF-Rendering:** Konfiguriere SMTP-Zustellung, Absenderzugangsdaten, Gotenberg-Verbindung, Zugangsdaten und Rendergrenzen.
- **Vorlagen, Sicherheit und Rechtliches:** Transaktionale E-Mail-Vorlagen, Ratenbegrenzungen, Standards für den Zugriffsschutz, Nutzungsbedingungen, Datenschutzerklärung und Impressum.
:::
