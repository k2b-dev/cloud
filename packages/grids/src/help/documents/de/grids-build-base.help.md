---
id: grids-build-base
title: Eine Basis erstellen
icon: ti ti-route
description: Erstelle aus einem echten Prozess eine kleine, nützliche Grids-Basis.
order: 106
---
Beginne bei der Arbeit, die Personen erledigen müssen, nicht bei einer Liste aller Grids-Funktionen. Eine gute erste Basis vereinfacht einen Prozess mit wenigen klaren Tabellen und Ansichten.

## Zuerst die Arbeit beschreiben {icon="square-plus"}

Notiere die wichtigsten Einträge, mit denen Personen arbeiten, und die Fragen, die sie dazu stellen. Bei Geräteausleihen könnten die Einträge Geräte, Personen und Ausleihen sein. Typische Fragen wären: „Was ist verfügbar?“, „Wer hat diesen Gegenstand?“ und „Welche Ausleihen sind überfällig?“

Jede Art von Eintrag wird normalerweise zu einer Tabelle. Jede Information, die zum Beantworten dieser Fragen nötig ist, wird zu einem Feld. Wiederkehrende Verbindungen zwischen verschiedenen Arten von Einträgen werden zu Relationen.

## Die erste nützliche Version erstellen {icon="square-plus"}

:::steps
1. **Erstelle die wichtigste Tabelle.** Gib ihr einen konkreten Namen im Plural, etwa Gegenstände, Rechnungen oder Anfragen.
2. **Füge Identitäts- und Arbeitsfelder hinzu.** Beginne mit einem verständlichen Namen, Status, einer verantwortlichen Person sowie den Daten oder Zahlen, die der Prozess benötigt.
3. **Wähle eine Datensatzbezeichnung.** Nimm das kurze Feld, das Personen in Relationen und Auswahlfeldern erkennen sollen.
4. **Erfasse repräsentative Datensätze.** Berücksichtige gewöhnliche, unvollständige und ungewöhnliche Fälle. Korrigiere jetzt missverständliche Feldnamen.
5. **Erstelle eine operative Ansicht.** Filtere und sortiere die Datensätze für eine wiederkehrende Aufgabe, etwa offene Anfragen oder überfällige Ausleihen.
6. **Lege den Zugriff fest, bevor du Personen einlädst.** Gib ihnen nur Zugriff auf die Ressourcen und Aktionen, die sie benötigen.
:::

Füge keine Grids App hinzu, die lediglich die Tabelle wiederholt, und keinen Workflow für einen noch unklaren Prozess. Ergänze die nächste Ressource, sobald ihr Zweck konkret ist:

| Bedarf | Ergänzung |
| --- | --- |
| Gezielte Dateneingabe | Ein Formular |
| Eine wiederverwendbare Teilmenge, ein Bericht, ein Kartenboard oder ein Kalender | Eine Ansicht |
| Eine rollenspezifische Arbeitsseite | Eine Grids App |
| Eine druck- oder teilbare PDF-Datei | Eine Dokumentvorlage |
| Eine wiederholbare Aktion mit mehreren Schritten | Ein Workflow |
| Eine zentral geregelte, schreibgeschützte Tabelle über mehrere Basen | Eine kombinierte Tabelle |

## Die Basis auf die Arbeit abstimmen {icon="settings"}

Öffne im Bearbeitungsmodus die **Basiseinstellungen**, um Einstellungen für die gesamte Basis zu bearbeiten:

- **Allgemein** hält Name und Beschreibung der Basis in der Grids-Übersicht verständlich.
- **Dokumente** speichert Geschäftsidentität, Adresse, Kontakt-, Zahlungs- und Fußzeilendaten für PDF- und E-Mail-Vorlagen.
- **Zugriff** steuert, wer den vollständigen Arbeitsbereich mit den Rohdaten der Basis verwenden darf. Nutze eine Grids App für einen engeren Personenkreis.
- **Papierkorb** listet gelöschte Tabellen, Felder und Formulare auf, die noch wiederhergestellt werden können.
- **Gefahrenbereich** nimmt die gesamte Basis aus der aktiven Nutzung, lässt sie aber durch eine Person mit Administratorrechten wiederherstellen.

Nutze eine Grids App, wenn Personen eine engere Arbeitsoberfläche als den direkten Zugriff auf die vollständige Basis benötigen.

## Beispiel: Geräteausleihen {icon="point"}

Erstelle die Tabellen **Gegenstände**, **Personen** und **Ausleihen**. Ein Datensatz in Ausleihen kann sich auf eine Person und mehrere Gegenstände beziehen und Felder für Ausleihdatum, Fälligkeitsdatum, Rückgabedatum und Status speichern.

Erstelle anschließend:

- eine Ansicht **Verfügbare Gegenstände** für die tägliche Suche;
- eine Ansicht **Offene Ausleihen**, sortiert nach Fälligkeitsdatum;
- ein Formular **Ausleihe anfragen** für eine geführte Eingabe;
- eine Grids App **Bestandsübersicht** für Mitarbeitende;
- eine Dokumentvorlage **Ausleihvereinbarung**;
- einen Scanner-Workflow **Gegenstand zurückgeben**, sobald die Regeln für die Rückgabe feststehen.

Das Ergebnis bleibt verständlich, weil jede Funktion eine Aufgabe erfüllt und alle Funktionen dieselben Datensätze verwenden.

## Vor dem Ausbau {icon="point"}

Nutze die Basis in der echten Arbeit. Prüfe, ob Personen Datensätze erkennen, Statuswerte verstehen, die richtige Ansicht finden und wissen, was sie ändern dürfen. Wenn das Modell bereits mit wenigen Beispielen unklar ist, verbirgt zusätzliche Automatisierung das Problem nur.

:::note Vorlagen als Ausgangspunkt
Eine Grids-Vorlage kann eine vollständige Beispiel-Basis erstellen. Behandle sie als anpassbares Arbeitsbeispiel: Benenne ihre Ressourcen um, prüfe die Beispieldaten und entferne alles, was dein Prozess nicht benötigt.
:::
