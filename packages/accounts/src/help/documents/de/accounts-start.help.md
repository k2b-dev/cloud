---
id: accounts-start
title: Erste Schritte
icon: ti ti-users-group
description: Konten, Gruppen, Anfragen, Dienstkonten, Benachrichtigungen und den Audit-Verlauf finden.
order: 100
---

Konten zeigt deinen eigenen Kontokontext. Die Administration ändert hier außerdem Personen und Gruppen, bearbeitet Kontoanfragen, widerruft API-Schlüssel, versendet Benachrichtigungsbatches und prüft den Kontoverlauf. Bevor du eine einzelne Person oder Gruppe öffnest, sieh dir **Übersicht** und die Navigation an. Sie zeigen deinen Zugriff, deinen Verwaltungsbereich und die wichtigsten Warteschlangen der Administration.

## Die Objekte kennen {icon="layout-grid"}

:::reference
- **Konto:** Ein Personeneintrag mit Anmeldeanbieter, Profil, Rollen, Ablaufdaten, Gruppenmitgliedschaften und optionalem Avatar.
- **Gruppe:** Eine lokale oder FreeIPA-Gruppe. Eine Gruppe kann Personen oder andere Gruppen enthalten. Sie kann außerdem andere Gruppen verwalten.
- **Kontoanfrage:** Eine eingereichte Anfrage nach Zugang. Die Administration kann daraus ein Konto erstellen oder die Anfrage mit einer optionalen Begründung per E-Mail ablehnen.
- **Dienstkonto-Schlüssel:** Ein API-Schlüssel einer Person oder einer Ressource. Einen aktiven Schlüssel kannst du widerrufen. Widerrufene Schlüssel bleiben für den Audit-Verlauf sichtbar.
:::

## Die richtige Seite finden {icon="route"}

:::reference
- **Eigenen Zugriff prüfen:** Öffne **Übersicht**. Sie zeigt Kontotyp, Verwaltungsbereich, Anmeldemethode, Ablaufdatum und Verknüpfungen zu deinen Gruppen.
- **Eine Gruppe finden:** Durchsuche unter **Gruppen** alle sichtbaren Gruppen, filtere nach Anbieter oder wechsle zwischen Gruppen, die du verwaltest, in denen du Mitglied bist oder die du sehen kannst.
- **Offene Anfragen prüfen:** Die Administration filtert **Anfragen** nach offenen, abgeschlossenen, abgelehnten oder allen Kontoanfragen.
- **Eine Änderung nachverfolgen:** Die Administration durchsucht das **Audit-Protokoll** nach Kontoereignissen und filtert nach handelnder Person, Ziel, Aktion, Ergebnis, Anbieter, Dienstkonto oder Zeitraum.
:::

:::info Wohin FreeIPA-Änderungen gehen
Bei aktiviertem FreeIPA schreibt der Konten-Dienst die Änderungen an FreeIPA-gestützten Personen und Gruppen. Lokale Konten und Gruppen bleiben in der Cloud-Datenbank.
:::

## Konto oder Gruppe finden {icon="search"}

:::steps
1. Wähle die Suchschaltfläche oder drücke **Cmd/Ctrl+Shift+K**. Die Cloud-Suche öffnet sich mit einem Chip **Konten**.
2. Suche nach einer Gruppe, die du sehen kannst. Die Administration findet außerdem Personen und Dienstkonten.
3. Wähle einen Treffer, um seine Seite in Konten zu öffnen.
:::

Entferne den Chip, um andere Apps zu durchsuchen.
