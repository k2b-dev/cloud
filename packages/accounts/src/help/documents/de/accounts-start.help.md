---
id: accounts-start
title: Erste Schritte
icon: ti ti-users-group
description: Konten, Gruppen, Anfragen, Dienstkonten, Benachrichtigungen und Audit-Verlauf.
order: 100
---

Accounts zeigt deinen eigenen Kontokontext und bündelt die Verwaltung von Personen, Gruppen, Kontoanfragen, API-Schlüsseln, Benachrichtigungsbatches und dem Kontoverlauf. Dashboard und Navigation geben dir vor dem Öffnen einzelner Personen oder Gruppen einen Überblick über deine Zugriffe, deinen Verwaltungsbereich und die wichtigsten administrativen Warteschlangen.

## Überblick {icon="layout-grid"}

:::reference
- **Konto:** Ein Personeneintrag mit Anmeldeanbieter, Profil, Rollen, Ablaufdaten, Gruppenmitgliedschaften und optionalem Avatar.
- **Gruppe:** Eine lokale oder FreeIPA-Gruppe. Gruppen können Personen oder andere Gruppen enthalten und Verwaltungsrechte für weitere Gruppen vergeben.
- **Kontoanfrage:** Eine eingereichte Zugriffsanfrage. Personen mit Administratorrechten können daraus ein Konto erstellen oder die Anfrage mit einer optionalen Begründung per E-Mail ablehnen.
- **Dienstkonto-Schlüssel:** Ein API-Schlüssel einer Person oder Ressource. Aktive Schlüssel lassen sich widerrufen; widerrufene Schlüssel bleiben für den Audit-Verlauf sichtbar.
:::

## Häufige Wege {icon="route"}

:::reference
- **Eigenen Zugriff prüfen:** Öffne das Dashboard, um Kontotyp, Verwaltungsbereich, Anmeldemethode, Ablaufdatum und Gruppenverknüpfungen zu sehen.
- **Eine Gruppe finden:** Suche unter Gruppen nach sichtbaren Gruppen, filtere nach Anbieter oder wechsle zwischen verwalteten, eigenen und sichtbaren Gruppen.
- **Offene Anfragen prüfen:** Filtere unter Anfragen nach offenen, abgeschlossenen, abgelehnten oder allen Kontoanfragen.
- **Eine Änderung nachverfolgen:** Suche im Audit-Protokoll nach Kontoereignissen und filtere nach handelnder Person, Ziel, Aktion, Ergebnis, Anbieter, Dienstkonto oder Zeitraum.
:::

:::info FreeIPA-Grenze
FreeIPA-gestützte Personen und Gruppen werden bei aktiviertem FreeIPA über den Accounts-Dienst geschrieben. Lokale Konten und Gruppen bleiben in der Cloud-Datenbank.
:::
