---
id: grids-build-custom-app
title: Erste Grids App erstellen
icon: ti ti-certificate
description: Eine Anfrage-App mit Fortschritt, Kommentaren und generiertem Zertifikat erstellen.
order: 133
---
Diese Anleitung erstellt eine App für Zertifikatsanfragen. Eine anfragende Person kann eine Anfrage absenden, ihre Anfragen sehen, eine Anfrage öffnen, sie besprechen, ihren Status verfolgen und das generierte Zertifikat herunterladen. Eine verantwortliche Gruppe kann alle Anfragen in derselben Basis bearbeiten.

Die App verwendet eine Tabelle und drei Seiten. Vorhandene Formulare, Ansichten, Workflows und Dokumentvorlagen bleiben jeweils für ihr Verhalten verantwortlich.

## Voraussetzungen {icon="list-check"}

Du benötigst Verwaltungsrechte für die Basis. Bereite diese Ressourcen in derselben Basis vor:

| Ressource | Erforderliche Konfiguration |
| --- | --- |
| Tabelle **Zertifikatsanfragen** | Felder Titel, Tätigkeitsdetails, Status und Bearbeitungshinweis |
| Formular **Zertifikat anfragen** | Erstellt Zertifikatsanfragen; Status ist fest auf Eingereicht gesetzt |
| Ansicht **Meine Zertifikatsanfragen** | Zeigt Titel, Status, Bearbeitungshinweis und Aktualisiert |
| Dokumentvorlage **Zertifikat** | Verwendet einen Datensatz aus Zertifikatsanfragen |
| Workflow-Launcher **Zertifikat genehmigen und generieren** | Validiert und aktualisiert die Anfrage, generiert das Dokument und benachrichtigt anschließend die anfragende Person |

Füge kein Feld für anfragende Personen hinzu, das nur die Identität dupliziert. Jeder Datensatz speichert bereits die erstellende Person. Das GQL der App kann `record.createdBy` mit `@auth.id` vergleichen. Generierte PDFs bleiben als Dokumente angehängt, statt in ein weiteres Dateifeld kopiert zu werden.

## Zuerst den Zugriff konfigurieren {icon="lock"}

Lege die Zielgruppengrenzen fest, bevor du Seiten zusammenstellst:

| Zielgruppe | Grenze | Ergebnis |
| --- | --- | --- |
| Anfragende Personen | Lesen in der Grids App | Nutzen nur die veröffentlichten Seiten, das persönliche GQL-Ergebnis, das enthaltene Formular, Kommentare und Dokumente. |
| Verantwortliche Gruppe | Schreiben in der Basis oder eine getrennte Grids App für Mitarbeitende | Bearbeitet alle Anfragen, ohne die Anfrage-App zu erweitern. |

Der Zugriff auf eine Grids App gewährt keinen unmittelbaren Basiszugriff. Die unveränderliche Veröffentlichung listet die exakten Daten und Operationen auf, die anfragenden Personen zur Verfügung stehen. Teste die Anfrage-App und die Oberfläche für Mitarbeitende vor der Veröffentlichung mit getrennten echten Testkonten.

**Prüfpunkt:** Eine anfragende Person kann das Formular absenden und die Datensatzabfrage der App gibt nur `record.createdBy = @auth.id` zurück. Die verantwortliche Gruppe kann alle Anfragen über ihre getrennte Grenze bearbeiten. Korrigiere bei einem Fehler die Abfrage oder trenne die Zielgruppen, bevor du weitere Seiten erstellst.

## Den Builder öffnen {icon="apps"}

Aktiviere den **Bearbeitungsmodus**, öffne die Basis und wähle unter **Apps** die Option **Neue App**. Der Builder erstellt eine Startseite, die du umbenennen oder erweitern kannst. Du kannst dieselbe kanonische Definition auch mit [YAML und CLI](/app/grids/help/grids-custom-app-yaml-cli) erstellen oder ersetzen. Nur Personen mit Verwaltungsrechten für die Basis sehen diese Steuerelemente.

Der Builder bearbeitet denselben kanonischen Entwurf wie YAML und CLI. Jede strukturell vollständige Änderung wird automatisch gespeichert. Semantische Diagnosen bleiben am Entwurf und blockieren die Veröffentlichung, statt deine Arbeit zu verwerfen. Der Status neben dem App-Namen unterscheidet **Aktiv**, **Unveröffentlichte Änderungen**, **Nur Entwurf** und einen Entwurf, der Aufmerksamkeit benötigt. Der Hinweis unter Seiten zeigt Speicherfehler, veröffentlicht den zuletzt gespeicherten Entwurf und kann den Entwurf nach Bestätigung des Verlusts aller Entwurfsänderungen auf die aktuelle aktive Version zurücksetzen. Das Symbol für einen externen Link öffnet diese aktive Version.

Die Arbeitsfläche zeigt die aktuelle Entwurfsseite: Gespeicherte Ansichten und parameterlose GQL-Ergebnisse ihrer Entwurfsseiten werden auf dem Server aufgelöst, Datensätze verwenden die gemeinsame Datentabelle, Kennzahlen und Diagramme stellen Aggregatergebnisse dar und Formulare verwenden die vollständige gemeinsame Formularoberfläche, wobei das Absenden während der Bearbeitung deaktiviert ist. Referenzierte Datensätze zeigen einen kontextbezogenen Platzhalter, weil ihr Ergebnis vom aktuellen Datensatz in der veröffentlichten Route abhängt. Gerendertes HTML folgt derselben Regel für kontextbezogene Vorschauen. Bewege den Mauszeiger über einen Block oder fokussiere ihn, um seinen kompakten Verschiebegriff zu zeigen. Ziehe ihn an eine horizontale Kante, um ihn vor oder nach einem anderen Block zu stapeln, oder an eine vertikale Kante, um ihn neben einem Block, einem benachbarten Paar oder dem vollständigen Stapel abzulegen. Zeiger, Berührung und Tastatur verwenden dieselben benannten Ziele und Ansagen. Zeilen, Spalten, leere Layoutcontainer und ausgeglichene Breiten werden automatisch erstellt oder entfernt; nur Blöcke werden ausgewählt und bearbeitet. **Block hinzufügen** gruppiert gewöhnliche Inhalte, Blöcke für den Seitendatensatz und erweiterte Einblicke oder Aktionen. Datenblöcke bevorzugen eine zugängliche gespeicherte Ansicht und verwenden andernfalls eine begrenzte GQL-Quelle aus einer verfügbaren Tabelle. Fehlende Voraussetzungen bleiben im Menü sichtbar, statt einen nicht nutzbaren Block zu erstellen.

Lege Folgendes fest:

- **Name:** Zertifikatsanfragen
- **Symbol:** Zertifikat
- **Startseite:** Antrag

Erstelle diese Seiten und prüfe sie anschließend im Builder:

| Seiten-ID | Titel | Navigation | Parameter |
| --- | --- | --- | --- |
| `apply` | Antrag | Sichtbar | Keine |
| `requests` | Meine Anfragen | Sichtbar | Keine |
| `request` | Anfragedetails | Verborgen | Erforderlicher Parameter `request_id`, Typ Record, Tabelle Zertifikatsanfragen |

Seiten-IDs sind stabile Kennungen der Definition. Du kannst sie in den Seiteneinstellungen bearbeiten; der Builder aktualisiert Navigationsreferenzen atomar. Bezeichnungen dürfen sich ändern, ohne die Navigation zu unterbrechen. Die verborgene Detailseite wird aus einer Zeile oder nach erfolgreichem Absenden des Formulars geöffnet.

**Prüfpunkt:** Der Entwurf öffnet Antrag, zeigt Antrag und Meine Anfragen in der Navigation und verbirgt Anfragedetails. Korrigiere andernfalls die Startseite, Sichtbarkeit jeder Seite und Reihenfolge im Seitenarray.

## Antrag erstellen {icon="forms"}

Füge eine Zeile über die volle Breite mit folgenden Blöcken hinzu:

1. Einen Markdown-Block, der die benötigten Informationen und die erwartete Bearbeitungszeit erklärt.
2. Einen Formularblock mit **Zertifikat anfragen**.

Wähle in den Einstellungen **Nach Erfolg** des Formularblocks **Navigieren**, als Ziel die Seite `request` und binde:

```text
request_id = RESULT.recordId
```

Aktiviere **Verlauf ersetzen**, damit Zurück nicht zu einem bereits abgeschlossenen Absendezustand führt. Das Formular bleibt für Pflichtfelder, Validierung, festen Status und Datensatzerstellung verantwortlich.

**Prüfpunkt:** Nach erfolgreichem Absenden öffnet sich die Detail-URL der neuen Anfrage. Wenn die Erstellung gelingt, aber die Navigation nicht, korrigiere die Erfolgsbindung statt des Formulars.

## Meine Anfragen erstellen {icon="list-details"}

Füge einen Datensatzblock mit **Meine Zertifikatsanfragen** hinzu. Zeige nur die Felder, die zur Identifikation einer Anfrage benötigt werden. Nutze je nach erwarteter Bildschirmbreite eine kompakte Tabelle oder Karten.

Lege als Zeilenziel die Seite `request` fest und binde:

```text
request_id = ROW.id
```

Das veröffentlichte GQL muss `record.createdBy = @auth.id` in der serverseitig ausgeführten Quelle behalten. Die von der Tabelle dargestellten Zeilen sind Präsentation und niemals Zugriffskontrolle.

**Prüfpunkt:** Die Auswahl einer sichtbaren Zeile öffnet ihre Detailseite. Das Ändern der URL auf eine andere Anfrage darf diesen Datensatz nicht offenlegen. Korrigiere Zeilennavigation und Zeilenautorisierung getrennt.

## Anfragedetails erstellen {icon="file-description"}

Füge unter **Routenparameter** einen Record-Parameter mit der ID `request_id` und der Tabelle **Zertifikatsanfragen** hinzu. Ergänze anschließend den Datensatzblock. Der Builder bindet denselben Routenparameter automatisch als Seitendatensatz; es gibt keine getrennte Einstellung für den Seitendatensatz:

```text
PARAMS.request_id
```

Ordne die Seite nach dem Arbeitsablauf:

1. Ein Datensatzblock mit Titel, Status, Bearbeitungshinweis und eingereichten Details.
2. Ein Kommentarblock für den Seitendatensatz.
3. Generierte Dokumente im Datensatzblock, begrenzt auf die Vorlage Zertifikat.
4. Einen Aktionsblock nur, wenn die aktuelle Zielgruppe einen passenden aktivierten Workflow-Launcher besitzt.

Felder für anfragende Personen sollten nach dem Absenden normalerweise schreibgeschützt sein. Wenn Korrekturen erlaubt sind, füge nur diese Felder unter **Bearbeitbare Felder** hinzu. Status, Genehmigungsdaten und generierte Ausgaben bleiben Eigentum des Workflows.

Wenn der Seitendatensatz fehlt, kann der Datensatzblock einen konfigurierten Leertext zeigen. Eine vorhandene Anfrage ohne generiertes Zertifikat besitzt einfach keinen Download-Eintrag; das aktuelle Schema kennt keinen eigenen Leertext für Dokumente.

**Prüfpunkt:** Status, Kommentare und generierte Dokumente bleiben nach dem Neuladen mit derselben Anfrage verknüpft. Ein Fehler gehört zur Datensatzbindung, zum Kommentarzugriff oder zu dem vom fehlerhaften Block benannten Dokument.

## Verarbeitung außerhalb des Layouts halten {icon="route"}

Die verantwortliche Gruppe kann Anfragen im Grids-Arbeitsbereich oder in einer zweiten gewöhnlichen Grids App bearbeiten. Ein besonderer Admin-App-Typ ist nicht erforderlich.

Der Workflow muss die Anfrage vor einer Änderung erneut lesen und validieren. Zusammengehörige Datensatzänderungen verwenden die atomare Grenze des Workflows für Datensatzänderungen; externe Auswirkungen beginnen erst nach der Festschreibung dieser Änderungen. So können nebenläufig prüfende Personen nicht unbemerkt einen veralteten Übergang anwenden.

## Den vollständigen Ablauf testen {icon="shield-check"}

Speichere den Entwurf, gewähre nur eigenen Testkonten für jede Zielgruppe Zugriff und prüfe:

:::steps
1. Sende als anfragende Person eine gültige Anfrage und prüfe, dass sich ihre Detailseite sofort öffnet.
2. Lade die Detail-URL neu und prüfe, dass dieselbe Anfrage geöffnet wird.
3. Verwende eine andere Anfrage-ID und prüfe, dass weder Existenz noch Daten dieses Datensatzes offengelegt werden.
4. Prüfe leere Liste, fehlende Kommentare, ausstehendes Dokument, abgeschlossenen Zustand, fehlenden Parameter und verweigerten Zugriff.
5. Prüfe als verantwortliche Gruppe, dass die vorgesehenen Datensätze und Aktionen für die Verarbeitung verfügbar sind.
6. Wiederhole den Ablauf auf breiten und schmalen Bildschirmen mit Tastaturnavigation.
:::

Die App ist bereit, wenn der Ablauf für anfragende Personen ohne Grids-Arbeitsbereich und ohne Kenntnisse der zugrunde liegenden Tabelle verständlich ist. Im Builder gibt es keinen Modus zur Nachahmung oder anonymen Vorschau. Teste öffentlichen Zugriff nur mit einer bewusst veröffentlichten Test-App.

## Eine App offline nehmen oder löschen {icon="alert-triangle"}

Öffne **App-Einstellungen** und klappe **Gefahrenzone** auf. **App-Veröffentlichung aufheben** entfernt den aktiven Snapshot sofort, erhält aber Entwurf und Zugriffsfreigaben. Du kannst die App später weiter bearbeiten und erneut veröffentlichen. **App löschen** entfernt die App und ihre aktive URL, löscht aber keine Tabellen oder Datensätze der Basis. Beide Aktionen zeigen vor der Änderung eine destruktive Bestätigung; das Löschen kann im Builder nicht rückgängig gemacht werden.

## Veröffentlichen und prüfen {icon="rocket"}

Führe die Vorabprüfung zur Veröffentlichung aus, prüfe jede angeforderte Capability und veröffentliche die App. Öffne die eigenständige URL und wiederhole den Ablauf für anfragende Personen mit dem veröffentlichten Snapshot.

Wenn etwas scheitert, korrigiere die zuständige Ebene:

| Problem | Zuständige Ebene |
| --- | --- |
| Fehlende oder ungültige `request_id` | Seitenparameter oder Navigationsbindung |
| Fehlende oder nicht verfügbare Anfrage | Veröffentlichte Abfrage, Seitenparameter oder `availableWhen` |
| Abgelehnte Eingabe | Formular |
| Veralteter Übergang oder teilweise Datensatzänderung | Workflow |
| Fehlendes PDF | Dokumentvorlage oder Dokument |
| Nicht verfügbare Aktion | Veröffentlichte Capability, Launcher-Status oder Berechtigung |

Lies [Seiten und Blöcke](/app/grids/help/grids-custom-app-pages-blocks) für alle Einstellungen, [Veröffentlichen und Berechtigungen](/app/grids/help/grids-publish-custom-app) für die Vorabprüfung und [YAML und CLI](/app/grids/help/grids-custom-app-yaml-cli) für den entsprechenden Agentenablauf.
