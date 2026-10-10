---
id: core-security
title: Anmeldung und Sicherheit
icon: ti ti-shield-lock
description: Anmelden, Zugang wiederherstellen, eine Anmelde-App koppeln und Passkeys, API-Schlüssel und Sitzungen schützen.
order: 112
---

Deine Anmeldeverfahren hängen vom Kontodienst und von den Einstellungen der Plattform ab. Nutze das Verfahren, das Cloud für dein Konto anbietet. Lege kein zweites Konto an.

## Anmelden und Zugang wiederherstellen {icon="shield-lock"}

Cloud kennt drei Kontotypen. Deine Organisation kann **Login** anders benennen.

:::reference
- **Guest:** Startet mit einem E-Mail-Link.
- **Login:** Startet mit der App, wenn die App-Anmeldung eingerichtet ist. Der E-Mail-Link bleibt als Alternative verfügbar.
- **FreeIPA:** Startet mit deinem Passwort.
:::

Ist die App-Anmeldung eingerichtet, können sich auch **Guest** und **FreeIPA** mit der App anmelden. Nach einer FreeIPA-Anmeldung mit der App öffnet dieser Browser FreeIPA beim nächsten Mal mit der App. Lokale Konten verwenden keine Passwörter.

Ein bestehender Passkey funktioniert weiter, solange dein Kontotyp erlaubt ist. Ist dein Kontotyp verborgen, nutze deinen Einladungslink oder deinen direkten Anmeldelink. Ein verborgener Kontotyp ist nicht dasselbe wie ein gesperrter Zugang. Ist dein Zugang gesperrt, wende dich an die Administration.

- Nutze die normale Anmeldung für den Kontodienst deines Kontos.
- Nutze einen Passkey, wenn du schon einen registriert hast und Browser und Gerät ihn unterstützen.
- Fordere die Passwortwiederherstellung nur für ein Konto mit wiederherstellbarem Passwort an.
- Nutze den Link aus der neuesten Wiederherstellungsnachricht. Ältere oder bereits verwendete Links können ungültig sein.
- Fehlt das erwartete Anmeldeverfahren oder ist der Kontodienst unklar, bitte die Administration, ihn zu prüfen.

## Anmelde-App koppeln {icon="device-mobile"}

Die Administration muss die App-Anmeldung zuerst aktivieren und einrichten. Zeigt **Anmeldung** den Status **Aktiviert — Einrichtung fehlt**, muss die Administration die App-Konfiguration noch abschließen. Nutze bis dahin deine bisherige Anmeldung.

:::warning Gib den Kopplungslink nicht weiter
Der Link gilt fünf Minuten. Teile ihn nicht außerhalb dieser Einrichtung.
:::

:::steps
1. Öffne **Profileinstellungen → Anmeldung → Gerät koppeln**.
2. Scanne den QR-Code oder kopiere den Kopplungslink in die App.
3. Kehre zu Cloud zurück und vergleiche die sechsstelligen Codes.
4. Wähle **Codes stimmen überein — Gerät koppeln** nur, wenn die Codes übereinstimmen.
5. Lass die App geöffnet, bis sie die Kopplung bestätigt.
:::

## Mit der App anmelden {icon="device-mobile"}

:::steps
1. Wähle deinen Kontotyp.
2. Zeigt die Seite **Stattdessen die App nutzen**, wähle diese Option.
3. Gib deine E-Mail-Adresse oder dein Kürzel ein.
4. Wähle **Mit App anmelden**.
5. Öffne die gekoppelte App.
6. Bestätige nur deine eigene Anfrage und nur mit dem übereinstimmenden Code.
:::

Ohne App können lokale Konten weiter einen E-Mail-Link nutzen und FreeIPA-Konten ihr Passwort. Bestehende Passkeys bleiben verfügbar.

Nach der Anmeldung bittet dich Cloud einmalig, die Nutzungsbedingungen anzunehmen und die Datenschutzhinweise zur Kenntnis zu nehmen. Bestätige, um fortzufahren, oder brich ab, um dich abzumelden.

Ist das Ergebnis einer Anmeldung unklar, lade die Seite neu, um deine Sitzung zu prüfen, oder starte eine neue Anfrage.

## Gekoppelte Geräte prüfen und widerrufen {icon="device-mobile"}

**Gekoppelte Geräte** zeigt für jedes Gerät den Namen, das Kopplungsdatum, die letzte Nutzung und ob die Administration bei der Kopplung geholfen hat. Benenne ein Gerät um oder widerrufe ein Gerät, das du nicht mehr kontrollierst. Ein widerrufenes Gerät kann keine neuen Anmeldungen bestätigen, bestehende Sitzungen bleiben aber angemeldet. Diese Funktionen bleiben auch bei ausgeschalteter App-Anmeldung verfügbar.

Hast du dein Gerät verloren und kannst dich nicht anmelden, bitte die Administration, es zu widerrufen.

:::warning Das Zurücksetzen des Passworts widerruft auch deine gekoppelten Geräte
Setzt du dein Passwort mit **Passwort zurücksetzen** auf der Anmeldeseite zurück, widerruft Cloud alle deine gekoppelten Geräte. Jede andere Abmeldung deines Kontos auf allen Geräten wirkt genauso. Kopple deine Geräte danach neu.
:::

Koppeln, Umbenennen und Widerrufen können eine Bestätigung deiner Identität verlangen. Melde dich mit demselben Konto an, ohne dich vorher abzumelden. Die Kopplung öffnet sich danach automatisch wieder.

## Konto schützen {icon="shield-lock"}

:::warning Gib Wiederherstellungslinks und API-Schlüssel nie weiter
Wer einen gültigen Wiederherstellungslink oder einen aktiven API-Schlüssel hat, kann möglicherweise mit dessen Zugriff handeln. Füge solche Daten nicht in Supportnachrichten, Screenshots oder Dokumentation ein.
:::

- Registriere Passkeys nur auf Geräten, die du kontrollierst. Gib ihnen erkennbare Namen und entferne Passkeys für Geräte, die du nicht mehr hast oder nutzt.
- Prüfe deine letzten Kontoaktivitäten auf unerwartete Änderungen oder eine unbekannte Nutzung von Zugangsdaten.
- Behandle API-Schlüssel wie Passwörter. Gib jeder Integration einen eigenen Schlüssel mit Ablaufdatum und widerrufe ihn, sobald du die Integration nicht mehr nutzt.
- Prüfe Browser und Konto, bevor du eine sicherheitsrelevante Aktion bestätigst.
