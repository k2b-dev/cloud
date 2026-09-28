---
id: venue-work
title: Schichten und öffentliche Seite
icon: ti ti-calendar-event
description: Arbeitsbereich, öffentliche Abschnitte, Feedback und Zugriff.
order: 110
---

Der Standort-Arbeitsbereich trennt die tägliche Personalplanung, persönliche Zuweisungen, öffentliche Inhalte, Feedback und administrative Einstellungen.

Alle Zeiten gelten in der Zeitzone des Standorts und im 24-Stunden-Format, egal wo du den Standort öffnest. Läuft dein Gerät in einer anderen Zeitzone, nennt der Arbeitsbereich die Zeitzone des Standorts über den Zeiten, als Sommer- oder Normalzeit für die gezeigten Tage.

## Ansichten im Arbeitsbereich {icon="layout-list"}

:::reference
- **Schichten:** Zeigt Zeiträume in einer Wochen- oder Monatsansicht. Personen mit Zugriff „Mitarbeit“ oder „Admin“ übernehmen eine Schicht mit **Schicht übernehmen** oder, wenn der Standort Schichtanmeldungen annimmt, per Doppelklick auf eine Schicht. Mit „Lesen“ zeigt der Kalender nur die Besetzung. Der Dialog listet alle Schichten der nächsten 14 Tage ab heute und sagt, bis wann die Liste reicht. **Weitere Schichten laden** ergänzt die nächsten 14 Tage. Schichten, die du schon hast, tragen **Du bist dabei**.
- **Zustand einer Schicht:** Jede Schicht nennt ihren Zustand in Worten und mit einem Symbol, die Farbe wiederholt ihn nur. Ist das Soll erreicht, steht dort ein Haken mit **Soll erreicht** oder **Voll**. Fehlen noch Personen, steht dort in Gelb, wie viele, etwa **1 fehlt**. Rot wird eine Schicht nur, wenn der Standort für sie erst mit voller Besetzung öffnet und sie innerhalb von 24 Stunden beginnt. Eine beendete Schicht ist grau und trägt **Beendet**. Die Besetzung lautet *besetzt von Soll*, zum Beispiel **0 von 1–3 besetzt · 1 fehlt**.
- **Meine Schichten:** Listet deine kommenden Schichten mit Wochentag, Datum, Beginn und Ende und dem Namen der Schicht; freie Zeiten heißen **Freier Zeitraum** und zeigen ihre Notiz. **Austreten** gibt eine Schicht nach einer Rückfrage ab, und dein Platz wird für andere frei.
- **Kalender abonnieren:** In **Meine Schichten** zeigt **Kalender abonnieren** deinen persönlichen Kalender-Link für deine Schichten an allen Standorten. **In Kalender-App öffnen** abonniert ihn auf deinem Gerät, **Link kopieren** kopiert ihn für Kalender-Apps, die nach einer URL fragen. Der Link ist persönlich: Wer ihn hat, sieht deine Schichten. **Link erneuern** ersetzt ihn, und der alte Link funktioniert sofort nicht mehr. Kalender mit dem alten Link brauchen den neuen.
- **Feedback:** Zeigt die durchschnittliche Bewertung pro Tag auf einer Skala von 1 bis 5, die Zahl der Bewertungen pro Tag, eine Kommentarsuche, den Filter **Nur mit Kommentar** und Zeitraumfilter für 7, 14 oder 30 Tage. Ein Zeitraum zählt Kalendertage in der Zeitzone des Standorts, heute eingeschlossen. Kennzahlen und Liste umfassen denselben Zeitraum. Die Liste zeigt 50 Bewertungen pro Seite. Suche und **Nur mit Kommentar** grenzen die Liste und ihre Anzahl ein, nicht die Kennzahlen. Diese Ansicht sehen nur Personen mit Zugriff „Mitarbeit“ oder „Admin“.
- **Öffentliche Abschnitte:** Administratoren können Abschnitte für Markdown, Speisekarte, Hinweise und Links erstellen, bearbeiten, duplizieren oder löschen. Der Schalter **Auf der öffentlichen Seite zeigen** entscheidet, ob Besucher einen Abschnitt sehen. Ist er aus, ist der Abschnitt ein Entwurf. Speichern übernimmt immer, was der Schalter zeigt. Entwürfe tragen in der Seitenleiste die Markierung **Entwurf**, und über jeder Vorschau steht, ob Besucher den Abschnitt sehen. Personen mit Zugriff „Mitarbeit“ oder „Admin“ sehen auch Entwürfe; mit „Lesen“ ist nur zu sehen, was die öffentliche Seite zeigt.
:::

## Einstellungen und Zugriff {icon="shield-lock"}

:::reference
- **Allgemein:** Name, Slug, Beschreibung, Symbol, Akzentfarbe, Logo, Banner und Feedback-Funktion bearbeiten. Mit „Lesen“ oder „Mitarbeit“ sind diese Einstellungen nur lesbar; ändern können sie nur Admins.
- **Zeitplan:** Logik für den öffentlichen Öffnungsstatus wählen und reguläre Öffnungszeiten, Ausnahmen für einzelne Tage sowie wiederkehrende Schichten verwalten.
- **Zugriff:** Administratoren vergeben Zugriff „Lesen“, „Mitarbeit“ oder „Admin“ an Personen, Gruppen, die Öffentlichkeit oder angemeldete Personen.
- **Links:** Öffentliche Seite öffnen oder **Kalender abonnieren** öffnen, denselben Dialog wie in **Meine Schichten**.
- **API-Schlüssel:** Administratoren erstellen ressourcengebundene Schlüssel für Integrationen, die Zugriff auf diesen Standort benötigen.
:::

## Wer was sieht {icon="eye"}

| Im Arbeitsbereich | Lesen | Mitarbeit | Admin |
| --- | --- | --- | --- |
| Schichtplan und eigene Schichten | Ja | Ja | Ja |
| Schichten übernehmen | Nein | Ja | Ja |
| Aus eigenen Schichten austreten | Ja | Ja | Ja |
| Öffentliche Abschnitte | So, wie die öffentliche Seite sie zeigt | Alle, auch Entwürfe | Alle, auch Entwürfe |
| Feedback von Besuchern: Bewertungen, Kommentare und Zahlen | Nein | Ja | Ja |
| Standorteinstellungen öffnen | Nur lesen | Nur lesen | Ja |
| Einstellungen, Zugriff, Zeitplan oder öffentliche Abschnitte ändern | Nein | Nein | Ja |
| Andere Personen aus einer Schicht entfernen | Nein | Nein | Ja |

Bei öffentlichen Abschnitten zeigt Zugriff „Lesen“ nicht mehr als die öffentliche Seite: Ist die öffentliche Seite ausgeschaltet, sehen Personen mit „Lesen“ keine. Die öffentliche Seite listet anstehende betreute Öffnungen als **Zusätzlich geöffnet** mit ihren Zeiten; interne Schichtnamen zeigt sie nie. Dieselben Regeln gelten für die API, `cld venue`, KI-Werkzeuge und Standort-API-Schlüssel mit der entsprechenden Berechtigung.

:::note Stabile Links
Standortlinks verwenden die unveränderliche Kurz-ID. Eine Änderung des sichtbaren Slugs betrifft die Auffindbarkeit, aber nicht die öffentlichen oder internen URLs.
:::
