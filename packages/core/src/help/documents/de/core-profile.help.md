---
id: core-profile
title: Profil und Konto
icon: ti ti-user-circle
description: Konto, Gruppen und Aktivitäten prüfen, FreeIPA-Zugang beantragen und API-Schlüssel und Passkeys nutzen.
updated: 2026-10-12
order: 110
---

Der Kontobereich bündelt lokale Cloud-Daten, optionale FreeIPA-Daten und die Aktionen, die du für dich selbst ausführst.

## Konto prüfen {icon="paperclip"}

:::reference
- **Profil:** Zeigt Anzeigename, Benutzername, Profilbild, Kontodienst, Profiltyp, zusätzliche Rollen, E-Mail-Adresse, Telefonnummer und Adresse. **Kontodaten** zeigt außerdem die verfügbaren Ablaufdaten.
- **Gruppen → Gruppenmitgliedschaften:** Zeigt zuerst deine direkten Gruppenmitgliedschaften. **Geerbte anzeigen** ergänzt die Mitgliedschaften aus der Gruppenhierarchie.
- **Gruppen → FreeIPA-Konto:** Ein lokales Konto kann FreeIPA-Zugang beantragen, wenn Kontoanfragen, die FreeIPA-Verbindung und FreeIPA-Konten erlaubt sind. Einen offenen Antrag kannst du auch dann zurückziehen, wenn neue Anfragen ausgeschaltet sind.
- **Freigaben:** Zeigt deine wartenden Aktionsanfragen aus allen Apps. Du kannst sie hier freigeben oder ablehnen. Jede Anfrage verlinkt den Chat, der auf sie wartet.
- **Anmeldung → Kontoaktivitäten:** Zeigt sicherheitsrelevante Kontoaktivitäten der letzten 7, 30 oder 90 Tage.
:::

## Anmeldung und Automatisierung schützen {icon="shield-lock"}

:::reference
- **Entwicklung → API-Schlüssel:** Persönliche Schlüssel für Automatisierung. Ein Schlüssel mit **Vollzugriff** hat denselben Zugriff wie dein Konto. Wenn deine Administration die OpenAI-kompatible API anbietet, kannst du stattdessen **Nur KI-Modelle** wählen: So ein Schlüssel kann nur die KI-Modelle aufrufen, die du im Assistenten nutzen darfst, zum Beispiel aus einer Diktier-App. Cloud zeigt den vollständigen Schlüssel nur einmal, direkt nach dem Erstellen.
- **Anmeldung → Passkeys:** WebAuthn-Passkeys für die Anmeldung an deinem Konto. Nachdem du einen Passkey entfernt hast, kann sich niemand mehr damit anmelden.
:::

## Darstellung wählen {icon="palette"}

Das Profilmenü zeigt deine aktuelle Darstellung als einen Eintrag. Wähle
ihn, um zur nächsten zu wechseln: **Automatisch**, **Hell**, **Dunkel**, dann
wieder **Automatisch**. Das Menü bleibt offen. Automatisch ist die
Standardeinstellung. Sie folgt der hellen oder dunklen Einstellung deines
Geräts.
