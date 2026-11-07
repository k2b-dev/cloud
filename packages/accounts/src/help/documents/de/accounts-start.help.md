---
id: accounts-start
title: Erste Schritte
icon: ti ti-users-group
description: Konten, Gruppen, Anfragen, Agenten, API Keys, Benachrichtigungen und den Audit-Verlauf finden.
order: 100
---

Die App Zugänge zeigt deinen eigenen Kontokontext. Die Administration ändert hier außerdem Personen und Gruppen, bearbeitet Kontoanfragen, widerruft API Keys, versendet Benachrichtigungsbatches und prüft den Kontoverlauf. Bevor du eine einzelne Person oder Gruppe öffnest, sieh dir **Übersicht** und die Navigation an. Sie zeigen deinen Zugriff, deinen Verwaltungsbereich und die wichtigsten Warteschlangen der Administration.

## Die Objekte kennen {icon="layout-grid"}

:::reference
- **Konto:** Eine Person, ein Agent oder ein Dienstkonto. Eine Person hat einen Anmeldeanbieter, ein Profil, Rollen, Ablaufdaten, Gruppenmitgliedschaften und optional einen Avatar.
- **Gruppe:** Eine lokale oder FreeIPA-Gruppe. Eine Gruppe kann Personen, Agenten oder andere Gruppen enthalten. Sie kann außerdem andere Gruppen verwalten.
- **Kontoanfrage:** Eine eingereichte Anfrage nach Zugang. Die Administration kann daraus ein Konto erstellen oder die Anfrage mit einer optionalen Begründung per E-Mail ablehnen.
- **API Key:** Eine weitere Anmeldung für ein Konto oder ein Schlüssel für eine Objektaktion. Einen aktiven Schlüssel kannst du widerrufen. Widerrufene Schlüssel bleiben für den Audit-Verlauf sichtbar.
:::

## Die richtige Seite finden {icon="route"}

:::reference
- **Eigenen Zugriff prüfen:** Öffne **Übersicht**. Sie zeigt Kontotyp, Verwaltungsbereich, Anmeldemethode, Ablaufdatum und Verknüpfungen zu deinen Gruppen.
- **Eine Gruppe finden:** Durchsuche unter **Gruppen** alle sichtbaren Gruppen, filtere nach Anbieter oder wechsle zwischen Gruppen, die du verwaltest, in denen du Mitglied bist oder die du sehen kannst.
- **Offene Anfragen prüfen:** Die Administration filtert **Anfragen** nach offenen, abgeschlossenen, abgelehnten oder allen Kontoanfragen.
- **Eine Änderung nachverfolgen:** Die Administration durchsucht das **Audit-Protokoll** nach Kontoereignissen und filtert nach handelnder Person, Ziel, Aktion, Ergebnis, Anbieter, Agent, Dienstkonto oder Zeitraum.
:::

:::info Wohin FreeIPA-Änderungen gehen
Bei aktiviertem FreeIPA schreibt die App Zugänge die Änderungen an FreeIPA-gestützten Personen und Gruppen. Lokale Konten und Gruppen bleiben in der Cloud-Datenbank.
:::

## Konto oder Gruppe finden {icon="search"}

:::steps
1. Wähle die Suchschaltfläche oder drücke **Cmd/Ctrl+Shift+K**. Die Cloud-Suche öffnet sich mit einem Chip **Zugänge**.
2. Suche nach einer Gruppe, die du sehen kannst. Die Administration findet außerdem Personen, Agenten und Dienstkonten.
3. Wähle einen Treffer, um seine Seite in der App Zugänge zu öffnen.
:::

Entferne den Chip, um andere Apps zu durchsuchen.
