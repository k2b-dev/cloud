---
id: core-admin
title: Administration
icon: ti ti-settings
description: Administrationsübersicht nutzen, Ankündigungen veröffentlichen, Core-Einstellungen ändern und App-Schlüssel rotieren.
order: 120
---

Die Core-Administrationsseiten konfigurieren Plattformdienste. Sie verlinken außerdem die Administrationsseiten, die jede App registriert.

Die Kontoeinstellungen verlinken mit **Dokumentation** die passende englische Anleitung. Sie öffnet sich in einem neuen Tab. Unter **Grundeinstellungen → Allgemein** wählst du mit **Dokumentationsadresse** die öffentliche Dokumentation, einen eigenen Spiegel oder deinen lokalen Fibel-Server. Diese Einstellung ändert nur die Links zur Dokumentation. Sie richtet keine App-Anmeldung ein, und die integrierte Hilfe bleibt davon unabhängig.

## Administrationsseiten finden {icon="user-cog"}

:::reference
- **Übersicht:** Listet die registrierten Apps mit Administrationsseiten. Sie zählt außerdem die registrierten Apps, die Administrationsseiten, die du öffnen kannst, und die Navigationseinträge, die Personen sehen.
- **Apps:** Jede App mit Zustand, Zugriff, Schlüsseln und Ereignissen. Öffne eine App, um zu sehen, warum sie Aufmerksamkeit braucht und was zu tun ist. Unter **Schlüssel** verwaltest du die App-Identität. Nutzermandate begrenzen weiterhin die Hintergrundaktionen.
- **Ankündigungen:** Erstelle und bearbeite Ankündigungen oder Banner. Ein Eintrag ist aktiv, geplant oder abgelaufen, je nach Veröffentlichungszeit und Ablaufzeit.
- **Einstellungen:** Bearbeite die Einstellungen nach Gruppen. Jedes Feld zeigt seinen aktuellen Wert. Wo der Einstellungsdienst sie bereitstellt, zeigt es auch die Quelle des Werts.
:::

## Kontotypen und Anmeldung steuern {icon="settings"}

Unter **Anmeldung & Sicherheit → Anmeldung** richtest du die Kontotypen **Guest**, **Login** und **FreeIPA** getrennt ein. **Login** ist das passwortlose lokale Konto. Benenne es mit **Anzeigename** um, etwa in Firmenaccount.

:::reference
- **Guest-Accounts erlauben**, **Lokale Vollaccounts erlauben**, **FreeIPA-Accounts erlauben:** Steuern den Zugriff.
- **Guest im Login anzeigen**, **Im Login anzeigen**, **FreeIPA im Login anzeigen:** Steuern nur die allgemeine Anmeldeseite. Ein verborgenes, erlaubtes Konto kann weiter direkte Links nutzen.
:::

Ist nur ein Kontotyp sichtbar, öffnet die Anmeldeseite sein Formular ohne Auswahl. Die Gast-Selbstregistrierung ist eine eigene Entscheidung.

:::warning Behalte einen Zugang, bevor du deinen eigenen Kontotyp sperrst
Halte einen anderen erlaubten Zugang für die Administration oder deinen Notfall-Token bereit.
:::

Das Sperren eines Kontotyps lehnt auch spätere Anfragen bestehender Sitzungen, benutzergebundener OAuth-Tokens, persönlicher API Keys und benutzergebundener Hintergrundarbeit ab. Es löscht keine Konten und stoppt nicht den FreeIPA-Sync. Erlaubst du den Typ wieder, funktionieren ansonsten gültige Zugangsdaten wieder. Die Notfallwiederherstellung erlaubt nach ausdrücklicher Bestätigung wieder alle lokalen **Login**-Konten. Welche Typen die Anmeldeseite zeigt, ändert sie nicht.

Unter **Admin → Anmeldung & Sicherheit → Anmeldung → Ortsangaben** siehst du Quelle und Erstellungsdatum der City- und ASN-Datenbanken. Lade eine eigene `.mmdb`- oder `.mmdb.gz`-Datei hoch oder setze einen Typ auf den mitgelieferten Stand zurück. Uploads bleiben bis zum Zurücksetzen aktiv. Sind die Daten älter als etwa sechs Monate, erscheint ein Hinweis. Die Datei muss eine City- oder ASN-Datenbank mit IPv6-Suchbaum sein; beachte die Lizenz des Anbieters. Es gelten 192 MiB entpackt und 128 MiB pro Upload-Anfrage. Solange DB-IP-Daten aktiv sind, erscheint der Quellenhinweis zu DB-IP.

## Die weiteren Einstellungsgruppen finden {icon="settings"}

:::reference
- **Grundeinstellungen:** **Allgemein** enthält Branding, öffentliche Links und globale Zeitpläne. **Rechtliches** enthält Nutzungsbedingungen, Datenschutzerklärung und Impressum. **PDF-Erstellung** enthält die Gotenberg-Verbindung, ihre Zugangsdaten und Grenzen. Dazu kommen **Orte & Karten** und **CLI**.
- **Anmeldung & Sicherheit → Registrierung:** Gast-Selbstregistrierung, FreeIPA-Zugangsanfragen, Kontovorgaben, Ablauf und Erinnerungen. Bei einer Neuinstallation sind Anfragen aus, bis du sie einschaltest. Ein Upgrade behält das bisherige Verhalten. Schaltest du neue Anfragen aus, bleiben offene Anfragen zur Bearbeitung verfügbar.
- **Hinweise zur Nacharbeit:** Unter **Registrierung & Anfragen** hinterlegst du eine optionale Liquid-Markdown-Vorlage für Hinweise nach erfolgreichen Benutzer- und Gruppenänderungen. Wähle mit `action` die Anweisungen für jede Änderung und prüfe die Vorschau mit Beispieldaten. Leere Ausgabe zeigt keinen Hinweis. Der Hinweis richtet sich an die Person aus Administration oder Gruppenverwaltung, die die Änderung ausführt. Er ist keine Benachrichtigung an die betroffene Person. NFS-Anweisungen sind nicht fest eingebaut.
- **Anmeldung & Sicherheit → Kontovorgänge:** Öffne gefilterte Lebenszyklus- und FreeIPA-Sync-Protokolle oder geplante Aufträge. Die Nachpflege repariert Ablaufdaten von Konten, keine Linux-Identitäten, und kann den Zugang abgelaufener Konten wiederherstellen. Ein Toast bestätigt, dass der Auftrag eingereiht ist. Den Abschluss prüfst du in seinen Protokollen. Einzelne Datensätze und die Bearbeitung von Anfragen bleiben in der App Zugänge.
- **Anmeldung & Sicherheit → Linux-Identitäten:** Reserviere einen ID-Bereich und lege Standardwerte für Home und Shell fest. Bei eingeschalteter Vergabe erhalten neue lokale Vollkonten und hochgestufte Gäste ihre Linux-Attribute automatisch. Das Einschalten ändert ältere Vollkonten nicht; nutze dafür **Backfill bestehender Accounts**. Schaltest du die Vergabe aus, verschwindet die Backfill-Tabelle, und bestehende Identitäten bleiben in der App Zugänge erhalten. Linux-Identitäten schalten weder die Anmeldung am Rechner noch sudo frei.
- **Anmeldung & Sicherheit → FreeIPA:** FreeIPA-Verbindungseinstellungen, Synchronisierungsregeln und Gruppenzuordnung.
- **KI:** Konfiguriere Modellprofile und Zugangsdaten der Anbieter und prüfe die Hintergrundarbeit. Mit **Skills** oder **Projekte** stellst du den Zugriff wieder her, wenn niemand mehr Zugriff **Verwalten** auf eine gemeinsam genutzte Ressource hat. Diese Wiederherstellungsseiten können Zugriff geben oder nicht mehr benötigte Ressourcen dauerhaft löschen. Einen gelöschten App-Skill installiert die App erst wieder, wenn du **Wiederherstellen** wählst.
- **Einstellungen → Ausgehende Mail:** SMTP-Zustellung und Absenderzugangsdaten. Für interne SMTP- und Bounce-IMAP-Hosts muss der Betreiber `OUTGOING_MAIL_ALLOWED_TARGETS` in Core setzen; standardmäßig sind nur öffentliche Ziele erlaubt.
- **Einstellungen → E-Mail-Vorlagen** und **Anmeldung & Sicherheit → Sicherheit:** Transaktionale E-Mail-Vorlagen, Ratenbegrenzungen und Standards für den Zugriffsschutz.
:::

## Erste Anmeldung für die Administration {icon="key"}

Bei einer neuen Installation hinterlegt der Betreiber vorübergehend `ADMIN_LOGIN_TOKEN`, und zwar nur in Core.

:::steps
1. Öffne `/auth/login?method=admin`.
2. Gib den Token ein.
3. Prüfe und akzeptiere die rechtlichen Dokumente, die Cloud anzeigt. Damit ist die erste Anmeldung abgeschlossen.
4. Richte die reguläre Anmeldung für die Administration ein.
5. Prüfe, ob die reguläre Anmeldung für die Administration funktioniert.
6. Bitte den Betreiber, den Token zu entfernen und Core neu zu starten.
:::

FreeIPA und die Gruppenzuordnung für die Administration richtest du in den Einstellungen ein. Es gibt keinen FreeIPA-Bootstrap über Umgebungsvariablen.

## App-Schlüssel rotieren {icon="key"}

Jede App außer Core und Gateway braucht einen eingetragenen Schlüssel zum
Starten und für signierte Aufrufe. Öffne unter **Apps** die App und **Schlüssel**.

:::steps
1. Wähle **Schlüssel erzeugen**, dann **Erzeugen**.
2. Lade den privaten Schlüssel jetzt herunter oder kopiere ihn. Core speichert nur den öffentlichen Teil.
3. Lass den Operator den neuen Schlüssel einbinden und jede Instanz neu starten.
4. Prüfe den Start und die Hintergrundarbeit der App.
5. Widerrufe den alten Schlüssel, sobald jede Instanz den neuen nutzt.
:::

Der Widerruf stoppt neue signierte Aufrufe sofort. Nach dem Widerruf des einzigen
aktiven Schlüssels braucht die App vor dem nächsten Start einen neuen. Bei
ausgeschaltetem Hintergrundzugriff aktiviert **Wieder aktivieren** das Konto;
widerrufene Schlüssel bleiben widerrufen. OAuth-Aussteller brauchen bei der
Eintragung über die CLI ausdrücklich die Freigabe `oauth:issue`.
