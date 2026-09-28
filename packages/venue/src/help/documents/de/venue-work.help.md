---
id: venue-work
title: Schichten und öffentliche Seite
icon: ti ti-calendar-event
description: Arbeitsbereich, öffentliche Abschnitte, Feedback und Zugriff.
order: 110
---

Der Standort-Arbeitsbereich trennt die tägliche Personalplanung, persönliche Zuweisungen, öffentliche Inhalte, Feedback und administrative Einstellungen.

## Ansichten im Arbeitsbereich {icon="layout-list"}

:::reference
- **Schichten:** Zeigt Zeiträume in einer Wochen- oder Monatsansicht. Personen mit Zugriff „Mitarbeit“ oder „Admin“ melden sich über die Aktion oder per Doppelklick auf eine Schicht an.
- **Meine Schichten:** Listet deine kommenden Zuweisungen und erlaubt, eigene Schichten zu stornieren.
- **Feedback:** Zeigt Bewertungstrends, eine Kommentarsuche und Zeitraumfilter für 7, 14 oder 30 Tage. Diese Ansicht sehen nur Personen mit Zugriff „Mitarbeit“ oder „Admin“.
- **Öffentliche Abschnitte:** Administratoren können Abschnitte für Markdown, Speisekarte, Hinweise und Links erstellen, bearbeiten, duplizieren oder löschen. „Mitarbeit“ und „Admin“ sehen auch ausgeblendete Abschnitte, „Lesen“ sieht nur, was die öffentliche Seite zeigt.
:::

## Einstellungen und Zugriff {icon="shield-lock"}

:::reference
- **Allgemein:** Name, Slug, Beschreibung, Symbol, Akzentfarbe, Logo, Banner und Feedback-Funktion bearbeiten.
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
| Öffentliche Abschnitte | So, wie die öffentliche Seite sie zeigt | Alle, auch ausgeblendete | Alle, auch ausgeblendete |
| Feedback von Besuchern: Bewertungen, Kommentare und Zahlen | Nein | Ja | Ja |
| Einstellungen, Zugriff, Zeitplan oder öffentliche Abschnitte ändern | Nein | Nein | Ja |
| Schichten anderer Personen stornieren | Nein | Nein | Ja |

Bei öffentlichen Abschnitten zeigt Zugriff „Lesen“ nicht mehr als die öffentliche Seite: Ist die öffentliche Seite ausgeschaltet, sehen Personen mit „Lesen“ keine. Dieselben Regeln gelten für die API, `cld venue`, KI-Werkzeuge und Standort-API-Schlüssel mit der entsprechenden Berechtigung.

:::note Stabile Links
Standortlinks verwenden die unveränderliche Kurz-ID. Eine Änderung des sichtbaren Slugs betrifft die Auffindbarkeit, aber nicht die öffentlichen oder internen URLs.
:::
