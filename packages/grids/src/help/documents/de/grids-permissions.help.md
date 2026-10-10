---
id: grids-permissions
title: Zugriff steuern
icon: ti ti-lock
description: Wähle zwischen vollständigem Zugriff auf eine Base und einer begrenzten Grids App.
order: 145
---
Grids regelt den Zugriff an zwei Stellen. Zugriff auf eine **Base** gilt für ihren vollständigen Arbeitsbereich mit Rohdaten. Zugriff auf eine **Grids App** gilt nur für diese veröffentlichte, auf eine Aufgabe ausgerichtete App. Tabellen, Ansichten, Formulare, Dokumentvorlagen und Workflows haben keinen eigenen Cloud-Zugriff.

Die Cloud-Administration ist in Grids nicht automatisch allmächtig. Sie kann Grids im Administrationsbereich konfigurieren, braucht auf normalen Grids-Seiten aber trotzdem Zugriff auf die Base.

## Zugriff auf eine Base geben {icon="database"}

Zugriff auf eine Base gilt für alle Tabellen, Felder, Datensätze, Ansichten, Formulare, Dokumentvorlagen und Workflows dieser Base.

Du kannst Personen, Gruppen, Dienstkonten und allen angemeldeten Konten Zugriff geben. Öffentlichen Zugriff auf eine Base gibt es nicht.

| Stufe | CLI-Wert | Was sie erlaubt |
| --- | --- | --- |
| **Ansehen** | `read` | Das vollständige Schema und jeden Datensatz der Base lesen, einschließlich Ansichten, GQL-Ergebnissen, Exporten und erzeugten Ausgaben. |
| **Bearbeiten** | `write` | Alles aus **Ansehen**. Dazu Datensätze erstellen, aktualisieren und löschen, Formulare absenden, Dokumente erzeugen und erlaubte Vorgänge der Base ausführen. |
| **Verwalten** | `admin` | Alles aus **Bearbeiten**. Dazu Schema und Konfiguration ändern, Zugriff ändern sowie Grids Apps erstellen, bearbeiten oder veröffentlichen. |
| **Kein Zugriff** | `none` | Den Zugriff auf die Base ausdrücklich verweigern. |

### Einen Eintrag mit Verwalten behalten

Eine Base behält immer mindestens einen Eintrag mit **Verwalten**. Er kann für eine Person, eine Gruppe, alle angemeldeten Konten oder ein eigenständiges Dienstkonto oder einen Agenten gelten. An die Base gebundene API-Schlüssel zählen nicht.

- Grids lehnt es ab, den letzten Eintrag mit **Verwalten** herabzustufen oder zu entfernen.
- Grids lehnt **Kein Zugriff** für dieselbe Person, Gruppe oder dasselbe Konto wie diesen Eintrag ab.
- Ein Eintrag mit **Verwalten** zählt nicht, solange dieselbe Person, Gruppe oder dasselbe Konto auch **Kein Zugriff** hat.
- Zählt nur noch ein Eintrag mit **Verwalten**, sperren die Zugriffseinstellungen diesen Eintrag.

Um eine Base zu übergeben, gib der neuen Person zuerst Zugriff **Verwalten**. Hat eine Base trotzdem keinen Eintrag mit **Verwalten** mehr, etwa weil das Konto gelöscht wurde, ergänzt die Cloud-Administration im Administrationsbereich einen neuen.

Grids zählt einen Eintrag mit **Verwalten** für eine Gruppe, ohne ihre Mitglieder zu prüfen. Für ein Mitglied entscheiden trotzdem zuerst sein eigener Eintrag oder **Kein Zugriff** für eine andere seiner Gruppen. Gib bei einer Übergabe deshalb der Person selbst Zugriff **Verwalten**.

### Zugriff mit einer App oder einer eigenen Base eingrenzen

Du kannst den Zugriff auf eine Base nicht auf eine Tabelle, Ansicht, ein Formular, einen Workflow oder die erstellende Person begrenzen. Darf eine Zielgruppe nur ausgewählte Daten oder Aktionen sehen, veröffentliche eine Grids App oder verschiebe die Daten in eine andere Base.

Wer einen Datensatz erstellt hat, bleibt als normale Information verfügbar. GQL in einer Grids App kann zum Beispiel `record.createdBy` mit `@auth.id` vergleichen. Diese Abfrage steuert das veröffentlichte Ergebnis. Sie ist kein verborgenes System für Zugriff auf Zeilenebene.

## Eine Grids App teilen {icon="app-window"}

Eine Grids App hat eigenen Zugriff. Ihre einzige Stufe ist **Offen** (`read`). `none` verweigert den Zugriff. Du kannst einer Person, einer Gruppe, allen angemeldeten Konten oder der Öffentlichkeit Zugriff geben. Öffentlicher Zugriff schließt anonyme Besucher ein. Grids Apps nehmen keine Dienstkonten an. Delegierte Anmeldedaten verwenden die Identität ihrer Person.

Personen, die die App verwenden, brauchen keinen Zugriff auf die Base. Sie erhalten nur die Daten, Formulare, Felder, Dokumente und Aktionen, die in den unveränderlichen veröffentlichten Snapshot kompiliert sind. Zugriff auf eine App gibt nie den Grids-Arbeitsbereich mit Rohdaten, direkte APIs für Tabellen oder Datensätze, beliebiges GQL oder eine bearbeitbare Quellansicht.

Nur eine Person mit Zugriff **Verwalten** auf die Base kann eine Grids App bearbeiten, als Vorschau öffnen, veröffentlichen, zurücksetzen, löschen oder ihren Zugriff ändern. Entwürfe und Vorschauen sind nie öffentlich.

Prüfe vor einer öffentlichen Veröffentlichung die Capability-Zusammenfassung im Builder. Sie nennt die Datenquellen, die beschreibbaren Formularfelder und weitere Vorgänge, die die Veröffentlichung bereitstellt. Nutze getrennte öffentliche und angemeldete Apps, wenn beide Zielgruppen unterschiedliche Capabilities brauchen.

## Die Durchsetzung auf dem Server verstehen {icon="shield-lock"}

Der Server setzt die veröffentlichte Definition und den Capability-Snapshot durch. Er prüft bei jeder Anfrage erneut, ob eine Seite, ein Block, ein Formular oder eine Aktion verfügbar ist. Ein Steuerelement im Browser auszublenden ist keine Autorisierung.

Eine nicht verfügbare Seite, ein Block, ein Formular oder eine Aktion liefert einen Nicht-gefunden-Fehler. Die zugehörige Abfrage oder Mutation läuft nicht. Öffentliche Lesevorgänge und Eingaben einer App nutzen dieselbe Grenze mit anonymem Kontext. Workflow-Aktionen erfordern ein angemeldetes Konto.

## Begrenzte öffentliche Links begrenzt halten {icon="world"}

Öffentliche Formulare und ablaufende Dokumentlinks bleiben tokenbasiert:

- Ein öffentliches Formular-Token erlaubt das Absenden dieses Formulars. Das Durchsuchen der Base erlaubt es nicht.
- Ein ablaufender Dokumentlink erlaubt das Herunterladen eines erzeugten Dokuments, bis der Link abläuft oder jemand ihn widerruft.

Diese Links erzeugen keinen Cloud-Zugriff auf Tabellen, Formulare oder Vorlagen.

## Zugriff über die CLI ändern {icon="terminal-2"}

```text
cld grids access set base MyBase --group "Operations" --permission write
cld grids access grant app MyBase "Public catalog" --public --permission read
cld grids access list app MyBase "Public catalog"
cld grids access revoke app MyBase "Public catalog" --public --yes
```

Führe `cld grids access reference` aus, um den installierten Vertrag zu Ressourcen, Zugriffsstufen und Principals zu sehen.
