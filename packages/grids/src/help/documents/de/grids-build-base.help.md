---
id: grids-build-base
title: Eine Base erstellen
icon: ti ti-route
description: Erstelle aus einem echten Prozess eine kleine, nützliche Grids-Base.
order: 106
---
Beginne bei der Arbeit, die Personen erledigen müssen, nicht bei einer Liste aller Grids-Funktionen. Eine gute erste Base vereinfacht einen Prozess mit wenigen klaren Tabellen und Ansichten.

## Zuerst die Arbeit beschreiben {icon="square-plus"}

Notiere die wichtigsten Einträge, mit denen Personen arbeiten, und die Fragen, die sie dazu stellen. Bei Geräteausleihen können die Einträge Geräte, Personen und Ausleihen sein. Typische Fragen sind: „Was ist verfügbar?“, „Wer hat diesen Gegenstand?“ und „Welche Ausleihen sind überfällig?“

Jede Art von Eintrag wird meist zu einer Tabelle. Jede Information, die diese Fragen beantwortet, wird zu einem Feld. Wiederkehrende Verbindungen zwischen Arten von Einträgen werden zu Relationen.

## Die erste nützliche Version erstellen {icon="square-plus"}

:::steps
1. **Erstelle die wichtigste Tabelle.** Gib ihr einen konkreten Namen im Plural, etwa Gegenstände, Rechnungen oder Anfragen.
2. **Füge Felder für Identität und Arbeit hinzu.** Beginne mit einem verständlichen Namen, einem Status und einer verantwortlichen Person. Ergänze die Daten oder Zahlen, die der Prozess braucht.
3. **Wähle eine Datensatzbezeichnung.** Nimm das kurze Feld, das Personen in Relationen und Auswahlfeldern erkennen müssen.
4. **Erfasse repräsentative Datensätze.** Berücksichtige gewöhnliche, unvollständige und ungewöhnliche Fälle. Korrigiere missverständliche Feldnamen jetzt.
5. **Erstelle eine operative Ansicht.** Filtere und sortiere die Datensätze für eine wiederkehrende Aufgabe, etwa offene Anfragen oder überfällige Ausleihen.
6. **Lege den Zugriff fest, bevor du Personen einlädst.** Gib Personen nur Zugriff auf die Ressourcen und Aktionen, die sie brauchen.
:::

Füge keine Grids App hinzu, die nur die Tabelle wiederholt. Füge keinen Workflow für einen Prozess hinzu, den Personen noch nicht verstehen. Ergänze die nächste Ressource, sobald ihr Zweck konkret ist:

| Bedarf | Ergänzung |
| --- | --- |
| Gezielte Dateneingabe | Ein Formular |
| Eine wiederverwendbare Teilmenge, ein Bericht, ein Kartenboard oder ein Kalender | Eine Ansicht |
| Eine Arbeitsseite für eine Rolle | Eine Grids App |
| Eine druck- oder teilbare PDF-Datei | Eine Dokumentvorlage |
| Eine wiederholbare Aktion mit mehreren Schritten | Ein Workflow |
| Eine zentral geregelte, schreibgeschützte Tabelle über mehrere Bases | Eine kombinierte Tabelle |

## Die Base auf die Arbeit abstimmen {icon="settings"}

Öffne im **Bearbeitungsmodus** die **Base-Einstellungen**. Dort gelten Einstellungen für die ganze Base:

:::reference
- **Allgemein:** Name und Beschreibung der Base in der Grids-Übersicht verständlich halten.
- **Dokumente:** Geschäftsidentität, Adresse, Kontakt-, Zahlungs- und Fußzeilendaten speichern. PDF- und E-Mail-Vorlagen verwenden sie.
- **Zugriff:** Festlegen, wer den vollständigen Arbeitsbereich mit den Rohdaten der Base verwenden kann.
- **Papierkorb:** Gelöschte Tabellen, Felder und Formulare auflisten, die du noch wiederherstellen kannst.
- **Gefahrenbereich:** Die ganze Base aus der aktiven Nutzung nehmen. Die Administration kann sie wiederherstellen.
:::

Nutze eine Grids App, wenn Personen eine engere Arbeitsseite brauchen als den direkten Zugriff auf die ganze Base.

## Beispiel: Geräteausleihen {icon="point"}

Erstelle die Tabellen **Gegenstände**, **Ausleihen** und **Ausleihpositionen**. Jede Position verbindet einen Gegenstand mit einer Ausleihe. Sie dokumentiert Ausgabe, Rückgabe und Zustand. Hinterlege die ausleihende Person an der Ausleihe. [Eine Geschäfts-App aufbauen](/app/grids/help/grids-build-business-app) zeigt die Prüfungen gegen doppelte Ausgaben und gegen Rückgaben über eine alte Ausleihe.

Erstelle danach:

- eine Ansicht **Verfügbare Gegenstände** für die tägliche Suche;
- eine Ansicht **Offene Ausleihen**, sortiert nach Fälligkeitsdatum;
- ein Formular **Ausleihe anfragen** für eine geführte Eingabe;
- eine Grids App **Bestandsübersicht** für Mitarbeitende;
- eine Dokumentvorlage **Ausleihvereinbarung**;
- einen Scanner-Workflow **Gegenstand zurückgeben**, sobald die Regeln für die Rückgabe feststehen.

Das Ergebnis bleibt verständlich, weil jede Funktion eine Aufgabe hat und alle Funktionen dieselben Datensätze verwenden.

## Die Base vor dem Ausbau prüfen {icon="point"}

Nutze die Base für echte Arbeit. Prüfe, ob Personen Datensätze erkennen, Statuswerte verstehen, die richtige Ansicht finden und wissen, was sie ändern können. Ist das Modell schon mit wenigen Beispielen unklar, verdeckt mehr Automatisierung das Problem nur.

:::note Eine Vorlage als Ausgangspunkt nutzen
Eine Grids-Vorlage kann eine vollständige Beispiel-Base erstellen. Nutze sie als anpassbares Arbeitsbeispiel: Benenne ihre Ressourcen um, prüfe die Beispieldatensätze und entferne alles, was dein Prozess nicht braucht.
:::
