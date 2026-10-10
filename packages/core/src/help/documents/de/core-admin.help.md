---
id: core-admin
title: Administration
icon: ti ti-settings
description: Administrationsübersicht nutzen, Ankündigungen veröffentlichen, Core-Einstellungen ändern und App-Zugänge rotieren.
order: 120
---

Die Core-Administrationsseiten konfigurieren Plattformdienste. Sie verlinken außerdem die Administrationsseiten, die jede App registriert.

Die Kontoeinstellungen verlinken mit **Dokumentation** die passende englische Anleitung. Sie öffnet sich in einem neuen Tab. Unter **Einstellungen → Allgemein** wählst du mit **Dokumentationsadresse** die öffentliche Dokumentation, einen eigenen Spiegel oder deinen lokalen Fibel-Server. Diese Einstellung ändert nur die Links zur Dokumentation. Sie richtet keine App-Anmeldung ein, und die integrierte Hilfe bleibt davon unabhängig.

## Administrationsseiten finden {icon="user-cog"}

:::reference
- **Übersicht:** Listet die registrierten Apps mit Administrationsseiten. Sie zählt außerdem die registrierten Apps, die Administrationsseiten, die du öffnen kannst, und die Navigationseinträge, die Personen sehen.
- **App-Zugänge:** Erstelle einen benannten Zugang für die Hintergrundarbeit einer App über App-Grenzen hinweg. Nutzermandate begrenzen weiterhin die Aktionen, die der Zugang ausführen kann.
- **Ankündigungen:** Erstelle und bearbeite Ankündigungen oder Banner. Ein Eintrag ist aktiv, geplant oder abgelaufen, je nach Veröffentlichungszeit und Ablaufzeit.
- **Einstellungen:** Bearbeite die Einstellungen nach Gruppen. Jedes Feld zeigt seinen aktuellen Wert. Wo der Einstellungsdienst sie bereitstellt, zeigt es auch die Quelle des Werts.
:::

## Kontotypen und Anmeldung steuern {icon="settings"}

Unter **Accounts & Anmeldung → Anmeldung** richtest du die Kontotypen **Guest**, **Login** und **FreeIPA** getrennt ein. **Login** ist das passwortlose lokale Konto. Benenne es mit **Anzeigename** um, etwa in Firmenaccount.

:::reference
- **Guest-Accounts erlauben**, **Lokale Vollaccounts erlauben**, **FreeIPA-Accounts erlauben:** Steuern den Zugriff.
- **Guest im Login anzeigen**, **Im Login anzeigen**, **FreeIPA im Login anzeigen:** Steuern nur die allgemeine Anmeldeseite. Ein verborgenes, erlaubtes Konto kann weiter direkte Links nutzen.
:::

Ist nur ein Kontotyp sichtbar, öffnet die Anmeldeseite sein Formular ohne Auswahl. Die Gast-Selbstregistrierung ist eine eigene Entscheidung.

:::warning Behalte einen Zugang, bevor du deinen eigenen Kontotyp sperrst
Halte einen anderen erlaubten Zugang für die Administration oder deinen Notfall-Token bereit.
:::

Das Sperren eines Kontotyps lehnt auch spätere Anfragen bestehender Sitzungen, benutzergebundener OAuth-Tokens, persönlicher API-Schlüssel und benutzergebundener Hintergrundarbeit ab. Es löscht keine Konten und stoppt nicht den FreeIPA-Sync. Erlaubst du den Typ wieder, funktionieren ansonsten gültige Zugangsdaten wieder. Die Notfallwiederherstellung erlaubt nach ausdrücklicher Bestätigung wieder alle lokalen **Login**-Konten. Welche Typen die Anmeldeseite zeigt, ändert sie nicht.

## Die weiteren Einstellungsgruppen finden {icon="settings"}

:::reference
- **Einstellungen → Allgemein:** Branding, öffentliche Links und globale Zeitpläne.
- **Accounts & Anmeldung → Registrierung & Anfragen:** Gast-Selbstregistrierung, FreeIPA-Zugangsanfragen, Kontovorgaben, Ablauf und Erinnerungen. Bei einer Neuinstallation sind Anfragen aus, bis du sie einschaltest. Ein Upgrade behält das bisherige Verhalten. Schaltest du neue Anfragen aus, bleiben offene Anfragen zur Bearbeitung verfügbar.
- **Hinweise zur Nacharbeit:** Unter **Registrierung & Anfragen** hinterlegst du eine optionale Liquid-Markdown-Vorlage für Hinweise nach erfolgreichen Benutzer- und Gruppenänderungen. Wähle mit `action` die Anweisungen für jede Änderung und prüfe die Vorschau mit Beispieldaten. Leere Ausgabe zeigt keinen Hinweis. Der Hinweis richtet sich an die Person aus Administration oder Gruppenverwaltung, die die Änderung ausführt. Er ist keine Benachrichtigung an die betroffene Person. NFS-Anweisungen sind nicht fest eingebaut.
- **Accounts & Anmeldung → Betrieb:** Öffne gefilterte Lebenszyklus- und FreeIPA-Sync-Protokolle oder geplante Aufträge. Die Nachpflege repariert Ablaufdaten von Konten, keine Linux-Identitäten, und kann den Zugang abgelaufener Konten wiederherstellen. Ein Toast bestätigt, dass der Auftrag eingereiht ist. Den Abschluss prüfst du in seinen Protokollen. Einzelne Datensätze und die Bearbeitung von Anfragen bleiben in Konten.
- **Accounts & Anmeldung → Linux-Identitäten:** Reserviere einen ID-Bereich und lege Standardwerte für Home und Shell fest. Bei eingeschalteter Vergabe erhalten neue lokale Vollkonten und hochgestufte Gäste ihre Linux-Attribute automatisch. Das Einschalten ändert ältere Vollkonten nicht; nutze dafür **Backfill bestehender Accounts**. Schaltest du die Vergabe aus, verschwindet die Backfill-Tabelle, und bestehende Identitäten bleiben in Konten erhalten. Linux-Identitäten schalten weder die Anmeldung am Rechner noch sudo frei.
- **Accounts & Anmeldung → FreeIPA:** FreeIPA-Verbindungseinstellungen, Synchronisierungsregeln und Gruppenzuordnung.
- **KI:** Konfiguriere Modellprofile und Zugangsdaten der Anbieter und prüfe die Hintergrundarbeit. Mit **Skills** oder **Projekte** stellst du den Zugriff wieder her, wenn niemand mehr Zugriff **Verwalten** auf eine gemeinsam genutzte Ressource hat. Diese Wiederherstellungsseiten können Zugriff geben oder nicht mehr benötigte Ressourcen dauerhaft löschen, auch Skills, die Cloud ursprünglich bereitgestellt hat.
- **Einstellungen → Ausgehende Mail** und **Einstellungen → PDF-Erstellung:** SMTP-Zustellung, Absenderzugangsdaten, Gotenberg-Verbindung und ihre Zugangsdaten sowie Grenzen für die PDF-Erstellung.
- **Einstellungen → E-Mail-Vorlagen**, **Einstellungen → Sicherheit** und **Einstellungen → Rechtliches:** Transaktionale E-Mail-Vorlagen, Ratenbegrenzungen, Standards für den Zugriffsschutz, Nutzungsbedingungen, Datenschutzerklärung und Impressum.
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

## App-Zugang rotieren {icon="key"}

**App-Zugänge** listet die vorhandenen Zugänge in einer Tabelle.

:::steps
1. Wähle unter **App-Zugänge** die Option **Zugang erstellen**.
2. Wähle im Dialog die **Anwendung**.
3. Gib unter **Name** einen Namen und bei Bedarf die Ablaufzeit ein.
4. Kopiere den Token. Cloud zeigt ihn nur einmal; danach bleiben nur seine Metadaten und **Widerrufen** verfügbar.
5. Hinterlege den Token über die Secret-Verwaltung des Deployments nur in der zugehörigen App als `CLOUD_APP_CREDENTIAL`.
6. Trage Cores interne Adresse in `CLOUD_CORE_INTERNAL_ORIGIN` ein. Hintergrundaufrufe brauchen sie.
7. Wende die Änderung an und prüfe die Hintergrundarbeit der App.
8. Wähle beim alten Zugang **Widerrufen** und bestätige im Dialog.
:::

Der Widerruf stoppt neue Aufrufe mit diesem Zugang.
