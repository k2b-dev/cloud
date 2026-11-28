---
id: core-profile
title: Profil und Konto
icon: ti ti-user-circle
description: Konto, Gruppen und Aktivitäten prüfen, FreeIPA-Zugang beantragen und API Keys und Passkeys nutzen.
updated: 2026-11-26
order: 110
---

Der Kontobereich bündelt lokale Cloud-Daten, optionale FreeIPA-Daten und die Aktionen, die du für dich selbst ausführst.

## Konto prüfen {icon="paperclip"}

:::reference
- **Profil:** Die erste Zeile zeigt, wie lange dein Konto gilt, deine Passkeys, Gruppen und API Keys. **Profil und Kontaktdaten** zeigt E-Mail-Adresse, Telefonnummer und Adresse; **Kontodaten** zeigt Kontotyp, zusätzliche Rollen, SSH-Schlüssel und das Ablaufdatum des Passworts, wenn es eines gibt.
- **Profil → Gruppen:** Zeigt deine ersten sechs Gruppen, zuerst die, die du verwaltest. **Alle meine Gruppen** zeigt alle, auch die Mitgliedschaften aus der Gruppenhierarchie.
- **Profil → FreeIPA-Konto:** Ein lokales Konto kann FreeIPA-Zugang beantragen, wenn Kontoanfragen, die FreeIPA-Verbindung und FreeIPA-Konten erlaubt sind. Einen offenen Antrag kannst du auch dann zurückziehen, wenn neue Anfragen ausgeschaltet sind.
- **Aktivität → Offene Freigaben:** Zeigt deine wartenden Aktionsanfragen aus allen Apps. Du kannst sie hier freigeben oder ablehnen. Jede Anfrage verlinkt den Chat, der auf sie wartet.
- **Aktivität → Anmeldungen und Änderungen:** Zeigt sicherheitsrelevante Kontoaktivitäten der letzten 7, 30 oder 90 Tage. **Aktivität → Zustellungen** zeigt, wohin deine Benachrichtigungen gingen.
:::

## Anmeldung und Automatisierung schützen {icon="shield-lock"}

:::reference
- **Sicherheit & Geräte → API Keys:** Persönliche Schlüssel für Automatisierung. Ein Schlüssel mit **Vollzugriff** hat denselben Zugriff wie dein Konto. Wenn deine Administration die OpenAI-kompatible API anbietet, kannst du stattdessen **Nur KI-Modelle** wählen: So ein Schlüssel kann nur die KI-Modelle aufrufen, die du im Assistenten nutzen darfst, zum Beispiel aus einer Diktier-App. Cloud zeigt den vollständigen Schlüssel nur einmal, direkt nach dem Erstellen.
- **Sicherheit & Geräte → Passkeys:** WebAuthn-Passkeys für die Anmeldung an deinem Konto. Nachdem du einen Passkey entfernt hast, kann sich niemand mehr damit anmelden.
:::

Lege API Keys und Passkeys unter **Sicherheit & Geräte** im
Browser an. Deine Browser-Anmeldung muss aus den letzten zehn Minuten stammen.
Bittet Cloud dich, deine Identität zu bestätigen, melde dich mit demselben Konto
erneut an. Der Dialog öffnet sich danach wieder. Die mobile App, eine Anmeldung über die
Kommandozeile und vorhandene API Keys können keine persönlichen
API Keys oder Passkeys anlegen.

## Darstellung wählen {icon="palette"}

Das Profilmenü zeigt deine aktuelle Darstellung als einen Eintrag. Wähle
ihn, um zur nächsten zu wechseln: **Automatisch**, **Hell**, **Dunkel**, dann
wieder **Automatisch**. Das Menü bleibt offen. Automatisch ist die
Standardeinstellung. Sie folgt der hellen oder dunklen Einstellung deines
Geräts.

## Inhalte mit dem Sichtschutz verdecken {icon="eye-off"}

Der Sichtschutz verdeckt deine Inhalte, wenn jemand über deine Schulter schaut.
Er sperrt nichts. Er verdeckt den ganzen Bildschirm, auch die App-Leiste.

:::reference
- **Sofort:** Wähle im Profilmenü **Sichtschutz** oder drücke **Strg+.**
  (**⌘+.** am Mac). Das Kürzel wirkt auch, wenn ein Dialog offen ist.
- **Automatisch:** Wenn du Cloud zwei Minuten nicht benutzt, verdeckt Cloud
  deine Inhalte. Wähle unter **Profil → Am Bildschirm** bei
  **Automatisch verdecken** eine andere Zeit oder **Aus**. Die Einstellung gilt
  auf allen Computern, an denen du dich anmeldest.
- **Vorwarnung:** Zehn Sekunden vorher erscheint über deinem Profil ein Symbol
  mit einem Ring, der sich leert. Jede Taste oder Mausbewegung hält den
  Sichtschutz auf.
- **Weiterarbeiten:** Drücke eine Taste oder wähle eine beliebige Stelle der
  Seite. Die Seite bekommt diese Eingabe nicht. Eine Mausbewegung lässt nur den
  Hinweis aufleuchten.
:::

Der Sichtschutz gilt für alle Cloud-Tabs dieses Browsers. Ein laufendes Diktat
und der Fortschritt eines Uploads bleiben sichtbar. Benachrichtigungen des
Betriebssystems verdeckt Cloud nicht. Auf Telefonen und Tablets ohne Maus oder
Touchpad gibt es keinen Sichtschutz.
