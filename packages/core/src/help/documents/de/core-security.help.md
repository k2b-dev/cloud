---
id: core-security
title: Anmeldung und Sicherheit
icon: ti ti-shield-lock
description: Anmeldeverfahren, Passwortwiederherstellung, Passkeys, API-Schlüssel, Sitzungen und Kontoschutz.
order: 112
---

Die verfügbaren Anmeldeverfahren hängen vom Kontodienst und den Einstellungen der Plattform ab. Verwende das Verfahren, das für dein bestehendes Konto angeboten wird, statt ein zweites Konto anzulegen.

## Anmelden und Zugriff wiederherstellen {icon="shield-lock"}

Die Accounttypen heißen **Guest**, **Login** (gegebenenfalls mit einem anderen
Namen deiner Organisation) und **FreeIPA**. Guest startet mit einem E-Mail-Link.
Wenn die App-Anmeldung eingerichtet ist, starten Login und FreeIPA mit der App;
E-Mail-Link beziehungsweise Passwort bleiben als Alternative verfügbar.
Lokale Accounts verwenden keine Passwörter. Ein bestehender Passkey funktioniert
weiter, solange der Accounttyp erlaubt ist. Nutze bei einem verborgenen Typ
deinen Einladungs- oder direkten Anmeldelink. Verbergen ist nicht dasselbe wie
Zugriff sperren; wende dich bei deaktiviertem Zugang an die Administration.

- Verwende die normale Anmeldung für den Kontodienst deines Kontos.
- Verwende einen bereits registrierten Passkey, wenn Browser und Gerät ihn unterstützen.
- Fordere die Passwortwiederherstellung nur für Konten mit wiederherstellbarer Passwortanmeldung an.
- Verwende den Link aus der neuesten Wiederherstellungsnachricht. Ältere oder bereits verwendete Links können ungültig sein.
- Wende dich an die Administration, wenn das erwartete Anmeldeverfahren fehlt oder der Kontodienst unklar ist.

## Anmelde-App koppeln und verwalten {icon="device-mobile"}

Wenn die Administration die App-Anmeldung aktiviert und eingerichtet hat, öffne **Mein Account
→ Sicherheit → Gerät koppeln**. Scanne den QR-Code, kopiere den Kopplungslink
in die App. Kehre zur Cloud zurück,
vergleiche die sechsstelligen Codes und bestätige nur, wenn sie übereinstimmen.
Lass die App geöffnet, bis sie die Kopplung bestätigt. Der Link gilt fünf
Minuten; teile ihn nicht außerhalb dieser Einrichtung.

Steht unter Sicherheit **Aktiviert — Einrichtung fehlt**, muss die Administration
die App-Konfiguration noch abschließen. Nutze bis dahin deine bisherige Anmeldung.

Wähle bei einer späteren Anmeldung deinen Accounttyp und bei Guest die App-Anmeldung
als Alternative. Gib E-Mail oder Kürzel ein und wähle **Mit App anmelden**. Öffne die gekoppelte App und
bestätige nur deine eigene Anfrage mit übereinstimmendem Code. Ohne App können
lokale Accounts weiterhin einen E-Mail-Link nutzen, FreeIPA-Accounts ihr
Passwort. Bestehende Passkeys bleiben verfügbar.

Nach der Anmeldung bittet dich die Cloud einmalig, ihre Nutzungsbedingungen
anzunehmen und die Datenschutzhinweise zur Kenntnis zu nehmen. Bestätige zum
Fortfahren oder brich ab, um dich abzumelden.

**Gekoppelte Geräte** zeigt Namen, Kopplungsdatum, letzte Nutzung und eine
mögliche Unterstützung durch die Administration. Benenne Geräte um oder
widerrufe Geräte, die du nicht mehr kontrollierst. Der Widerruf verhindert neue
Anmeldungen, beendet aber keine bestehenden Sitzungen. Die Verwaltung bleibt
auch bei deaktivierter App-Anmeldung verfügbar.

Koppeln, Umbenennen und Widerrufen können eine Bestätigung deiner Identität verlangen.
Melde dich mit demselben Account an, ohne dich vorher abzumelden.
Die Kopplung öffnet sich danach automatisch wieder.
Ist das Ergebnis einer Anmeldung unklar, lade die Seite neu, um deine Sitzung
zu prüfen, oder starte eine neue Anfrage.

## Konto schützen {icon="shield-lock"}

- Registriere Passkeys nur auf Geräten, die du kontrollierst. Vergib erkennbare Namen und entferne Passkeys für verlorene oder nicht mehr verwendete Geräte.
- Prüfe die Kontoaktivitäten auf unerwartete Änderungen oder die unbekannte Verwendung von Zugangsdaten.
- Behandle API-Schlüssel wie Passwörter. Verwende pro Integration einen eigenen Schlüssel mit Ablaufdatum und widerrufe ihn, sobald die Integration nicht mehr verwendet wird.
- Prüfe Browser und Konto, bevor du eine sicherheitsrelevante Aktion bestätigst.

:::warning Wiederherstellungslinks und API-Schlüssel nicht weitergeben
Wer über einen gültigen Wiederherstellungslink oder aktiven API-Schlüssel verfügt, kann möglicherweise mit den zugehörigen Berechtigungen handeln. Füge solche Daten nicht in Supportnachrichten, Screenshots oder Dokumentationen ein.
:::
