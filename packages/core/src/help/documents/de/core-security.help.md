---
id: core-security
title: Anmeldung und Sicherheit
icon: ti ti-shield-lock
description: Anmeldeverfahren, Passwortwiederherstellung, Passkeys, API-Schlüssel, Sitzungen und Kontoschutz.
order: 112
---

Die verfügbaren Anmeldeverfahren hängen vom Kontodienst und den Einstellungen der Plattform ab. Verwende das Verfahren, das für dein bestehendes Konto angeboten wird, statt ein zweites Konto anzulegen.

## Anmelden und Zugriff wiederherstellen {icon="shield-lock"}

- Verwende die normale Anmeldung für den Kontodienst deines Kontos.
- Verwende einen bereits registrierten Passkey, wenn Browser und Gerät ihn unterstützen.
- Fordere die Passwortwiederherstellung nur für Konten mit wiederherstellbarer Passwortanmeldung an.
- Verwende den Link aus der neuesten Wiederherstellungsnachricht. Ältere oder bereits verwendete Links können ungültig sein.
- Wende dich an die Administration, wenn das erwartete Anmeldeverfahren fehlt oder der Kontodienst unklar ist.

## Konto schützen {icon="shield-lock"}

- Registriere Passkeys nur auf Geräten, die du kontrollierst. Vergib erkennbare Namen und entferne Passkeys für verlorene oder nicht mehr verwendete Geräte.
- Prüfe die Kontoaktivitäten auf unerwartete Änderungen oder die unbekannte Verwendung von Zugangsdaten.
- Behandle API-Schlüssel wie Passwörter. Verwende pro Integration einen eigenen Schlüssel mit Ablaufdatum und widerrufe ihn, sobald die Integration nicht mehr verwendet wird.
- Prüfe Browser und Konto, bevor du eine sicherheitsrelevante Aktion bestätigst.

:::warning Wiederherstellungslinks und API-Schlüssel nicht weitergeben
Wer über einen gültigen Wiederherstellungslink oder aktiven API-Schlüssel verfügt, kann möglicherweise mit den zugehörigen Berechtigungen handeln. Füge solche Daten nicht in Supportnachrichten, Screenshots oder Dokumentationen ein.
:::
