---
id: grids-permissions
title: Berechtigungen
icon: ti ti-lock
description: Zwischen vollständigem Basiszugriff und einer begrenzten Grids App wählen.
order: 145
---
Grids besitzt zwei Cloud-Berechtigungsgrenzen: eine **Basis** für den vollständigen unmittelbaren Arbeitsbereich und eine **Grids App** für eine veröffentlichte, auf eine Aufgabe ausgerichtete Oberfläche. Tabellen, Ansichten, Formulare, Dokumentvorlagen und Workflows besitzen keine eigenen Cloud-Freigaben.

Cloud-Administratoren sind nicht automatisch Grids-Superuser. Sie können Grids im Administrationsbereich verwalten, benötigen auf normalen Grids-Seiten aber weiterhin Zugriff auf die Basis.

## Zugriff auf eine Basis gewähren {icon="database"}

Eine Freigabe für eine Basis gilt für alle Tabellen, Felder, Datensätze, Ansichten, Formulare, Dokumentvorlagen und Workflows in dieser Basis.

Basisfreigaben unterstützen Personen, Gruppen, Dienstkonten und alle angemeldeten Konten. Öffentliche Principals werden nicht unterstützt.

| Stufe | Erlaubte Aktionen |
| --- | --- |
| **Lesen** | Das vollständige Schema und jeden Datensatz der Basis lesen, einschließlich Ansichten, GQL-Ergebnissen, Exporten und generierten Ausgaben. |
| **Schreiben** | Zusätzlich Datensätze erstellen, aktualisieren und löschen, Formulare absenden, Dokumente erzeugen und erlaubte Basisoperationen ausführen. |
| **Verwalten** | Zusätzlich Schema und Konfiguration ändern, Zugriffe verwalten sowie Grids Apps erstellen, bearbeiten oder veröffentlichen. |
| **Keine** | Den Zugriff auf die Basis ausdrücklich verweigern. |

Der Basiszugriff kann nicht auf eine Tabelle, Ansicht, ein Formular, einen Workflow oder erstellende Personen begrenzt werden. Wenn eine Zielgruppe nur ausgewählte Daten oder Aktionen sehen darf, veröffentliche eine Grids App oder trenne die Daten in eine andere Basis.

Metadaten zu erstellenden Personen bleiben als normale Daten verfügbar. GQL kann zum Beispiel innerhalb einer Grids App `record.createdBy` mit `@auth.id` vergleichen. Diese Abfrage steuert das veröffentlichte Ergebnis. Sie ist kein verborgenes System für Berechtigungen auf Zeilenebene.

## Eine Grids App teilen {icon="app-window"}

Eine Grids App besitzt eigene Freigaben für **Lesen** oder **Keine**. Gewähre sie einer Person, Gruppe, allen angemeldeten Konten oder öffentlich. Eine öffentliche Freigabe schließt anonyme Besucher ein. Freigaben für Grids Apps unterstützen keine Dienstkonten; delegierte Anmeldedaten verwenden die zugehörige Personenidentität.

Lesende Personen der App benötigen keinen Zugriff auf die Basis. Sie erhalten nur die Daten, Formulare, Felder, Dokumente und Aktionen, die in den unveränderlichen veröffentlichten Snapshot kompiliert wurden. Der App-Zugriff gewährt niemals den unmittelbaren Grids-Arbeitsbereich, direkte Tabellen- oder Datensatz-APIs, beliebiges GQL oder eine bearbeitbare Quellansicht.

Nur eine Person mit Verwaltungsrechten für die Basis kann eine Grids App bearbeiten, als Vorschau öffnen, veröffentlichen, zurücksetzen, löschen oder ihre Zugriffe verwalten. Entwürfe und Vorschauen sind niemals öffentlich.

Prüfe vor einer öffentlichen Veröffentlichung die Capability-Zusammenfassung im Builder. Sie nennt die Datenquellen, beschreibbaren Formularfelder und weiteren Operationen, die durch die Veröffentlichung verfügbar werden. Nutze getrennte öffentliche und angemeldete Apps, wenn beide Zielgruppen unterschiedliche Capabilities benötigen.

## Serverseitige Durchsetzung verstehen {icon="shield-lock"}

Die veröffentlichte Definition und der Capability-Snapshot werden serverseitig durchgesetzt. Die Verfügbarkeit von Seiten, Blöcken, Formularen und Aktionen wird bei jeder Anfrage erneut geprüft. Das Ausblenden eines Steuerelements im Browser ist keine Autorisierung.

Eine nicht verfügbare Seite, ein Block, Formular oder eine Aktion gibt **Nicht gefunden** zurück und führt weder die zugehörige Abfrage noch Mutation aus. Öffentliche App-Lesevorgänge und Eingaben nutzen dieselbe Grenze mit anonymem Kontext. Workflow-Aktionen erfordern ein angemeldetes Konto.

## Begrenzte öffentliche Links begrenzt halten {icon="world"}

Öffentliche Formulare und ablaufende Dokumentlinks bleiben tokenbasierte Oberflächen:

- Ein öffentlicher Formular-Token erlaubt das Absenden dieses Formulars, nicht das Durchsuchen der Basis.
- Ein ablaufender Dokumentlink erlaubt das Herunterladen eines generierten Dokuments, bis er abläuft oder widerrufen wird.

Diese Links erstellen keine Cloud-Berechtigungen auf Tabellen-, Formular- oder Vorlagenebene.

## Zugriff über die CLI verwalten {icon="terminal-2"}

```text
cld grids access set base MyBase --group "Operations" --permission write
cld grids access grant app MyBase "Public catalog" --public --permission read
cld grids access list app MyBase "Public catalog"
cld grids access revoke app MyBase "Public catalog" --public --yes
```

Nutze `cld grids access reference` für den installierten Vertrag zu Ressourcen, Berechtigungen und Principals.
