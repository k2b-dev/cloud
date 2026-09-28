---
id: venue-work
title: Schichten und öffentliche Seite
icon: ti ti-calendar-event
description: Arbeitsbereich, öffentliche Abschnitte, Feedback und Zugriff.
order: 110
---

Der Standort-Arbeitsbereich trennt die tägliche Personalplanung, persönliche Zuweisungen, öffentliche Inhalte, Feedback und administrative Einstellungen.

Alle Zeiten gelten in der Zeitzone des Standorts und im 24-Stunden-Format, egal wo du den Standort öffnest. Läuft dein Gerät in einer anderen Zeitzone, nennt der Arbeitsbereich die Zeitzone des Standorts über den Zeiten.

## Ansichten im Arbeitsbereich {icon="layout-list"}

:::reference
- **Schichten:** Zeigt Zeiträume in einer Wochen- oder Monatsansicht. Personen mit Zugriff „Mitarbeit“ oder „Admin“ melden sich über die Aktion oder per Doppelklick auf eine Schicht an. Der Anmelde-Dialog listet alle Schichten der nächsten 14 Tage ab heute und sagt, bis wann die Liste reicht. **Weitere Schichten laden** ergänzt die nächsten 14 Tage.
- **Meine Schichten:** Listet deine kommenden Zuweisungen mit Tag und Uhrzeit und erlaubt, eigene Schichten zu stornieren.
- **Feedback:** Zeigt Bewertungstrends, eine Kommentarsuche und Zeitraumfilter für 7, 14 oder 30 Tage. Ein Zeitraum zählt Kalendertage in der Zeitzone des Standorts, heute eingeschlossen. Kennzahlen und Liste umfassen denselben Zeitraum. Die Liste zeigt 50 Bewertungen pro Seite; eine Suche grenzt die Liste ein, nicht die Kennzahlen. Diese Ansicht sehen nur Personen mit Zugriff „Mitarbeit“ oder „Admin“.
- **Öffentliche Abschnitte:** Administratoren können Abschnitte für Markdown, Speisekarte, Hinweise und Links erstellen, bearbeiten, duplizieren oder löschen. Der Schalter **Auf der öffentlichen Seite zeigen** entscheidet, ob Besucher einen Abschnitt sehen. Ist er aus, ist der Abschnitt ein Entwurf. Speichern übernimmt immer, was der Schalter zeigt. Entwürfe tragen in der Seitenleiste die Markierung **Entwurf**, und über jeder Vorschau steht, ob Besucher den Abschnitt sehen. „Mitarbeit“ und „Admin“ sehen auch Entwürfe, „Lesen“ sieht nur, was die öffentliche Seite zeigt.
:::

## Einstellungen und Zugriff {icon="shield-lock"}

:::reference
- **Allgemein:** Name, Slug, Beschreibung, Symbol, Akzentfarbe, Logo, Banner und Feedback-Funktion bearbeiten. Mit „Lesen“ oder „Mitarbeit“ sind diese Einstellungen nur lesbar; ändern können sie nur Admins.
- **Zeitplan:** Logik für den öffentlichen Öffnungsstatus wählen und reguläre Öffnungszeiten, geschlossene Tage sowie wiederkehrende Schichten verwalten.
- **Zugriff:** Administratoren vergeben Zugriff „Lesen“, „Mitarbeit“ oder „Admin“ an Personen, Gruppen, die Öffentlichkeit oder angemeldete Personen.
- **Links:** Öffentliche Seite öffnen oder das persönliche iCal-Abonnement für Standortschichten kopieren.
- **API-Schlüssel:** Administratoren erstellen ressourcengebundene Schlüssel für Integrationen, die Zugriff auf diesen Standort benötigen.
:::

## Wer was sieht {icon="eye"}

| Im Arbeitsbereich | Lesen | Mitarbeit | Admin |
| --- | --- | --- | --- |
| Schichtplan und eigene Schichten | Ja | Ja | Ja |
| Für Schichten anmelden | Nein | Ja | Ja |
| Eigene Schichten stornieren | Ja | Ja | Ja |
| Öffentliche Abschnitte | So, wie die öffentliche Seite sie zeigt | Alle, auch Entwürfe | Alle, auch Entwürfe |
| Feedback von Besuchern: Bewertungen, Kommentare und Zahlen | Nein | Ja | Ja |
| Standorteinstellungen öffnen | Nur lesen | Nur lesen | Ja |
| Einstellungen, Zugriff, Zeitplan oder öffentliche Abschnitte ändern | Nein | Nein | Ja |
| Schichten anderer Personen stornieren | Nein | Nein | Ja |

Bei öffentlichen Abschnitten zeigt Zugriff „Lesen“ nicht mehr als die öffentliche Seite: Ist die öffentliche Seite ausgeschaltet, sehen Personen mit „Lesen“ keine. Dieselben Regeln gelten für die API, `cld venue`, KI-Werkzeuge und Standort-API-Schlüssel mit der entsprechenden Berechtigung.

:::note Stabile Links
Standortlinks verwenden die unveränderliche Kurz-ID. Eine Änderung des sichtbaren Slugs betrifft die Auffindbarkeit, aber nicht die öffentlichen oder internen URLs.
:::
