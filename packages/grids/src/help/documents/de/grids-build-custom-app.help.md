---
id: grids-build-custom-app
title: Erste Grids App erstellen
icon: ti ti-certificate
description: Erstelle eine Anfrage-App mit Fortschritt, Kommentaren und erzeugtem Zertifikat.
order: 133
---
Diese Anleitung erstellt eine App für Zertifikatsanfragen. Eine anfragende Person kann eine Anfrage absenden, ihre Anfragen sehen, eine Anfrage öffnen, sie besprechen, ihren Status verfolgen und das erzeugte Zertifikat herunterladen. Eine verantwortliche Gruppe bearbeitet alle Anfragen in derselben Base.

Die App verwendet eine Tabelle und drei Seiten. Vorhandene Formulare, Ansichten, Workflows und Dokumentvorlagen behalten ihr eigenes Verhalten.

## Die Ressourcen vorbereiten {icon="list-check"}

Du brauchst Zugriff **Verwalten** auf die Base. Bereite diese Ressourcen in derselben Base vor:

| Ressource | Erforderliche Konfiguration |
| --- | --- |
| Tabelle **Zertifikatsanfragen** | Felder Titel, Tätigkeitsdetails, Status und Bearbeitungshinweis |
| Formular **Zertifikat anfragen** | Erstellt Zertifikatsanfragen; Status ist fest auf Eingereicht gesetzt |
| Ansicht **Meine Zertifikatsanfragen** | Zeigt Titel, Status, Bearbeitungshinweis und Aktualisiert |
| Dokumentvorlage **Zertifikat** | Verwendet einen Datensatz aus Zertifikatsanfragen |
| Workflow-Launcher **Zertifikat genehmigen und generieren** | Validiert und aktualisiert die Anfrage, erzeugt das Dokument und benachrichtigt danach die anfragende Person |

Füge kein Feld für die anfragende Person hinzu, das nur die Identität wiederholt. Jeder Datensatz speichert bereits die erstellende Person, und das GQL der App kann `record.createdBy` mit `@auth.id` vergleichen. Erzeugte PDFs bleiben als Dokumente angehängt. Kopiere sie nicht in ein weiteres Dateifeld.

## Zuerst den Zugriff konfigurieren {icon="lock"}

Lege die Grenzen jeder Zielgruppe fest, bevor du Seiten baust:

| Zielgruppe | Grenze | Ergebnis |
| --- | --- | --- |
| Anfragende Personen | Zugriff **Offen** auf die Grids App | Nutzen nur die veröffentlichten Seiten, das persönliche GQL-Ergebnis, das enthaltene Formular, Kommentare und Dokumente. |
| Verantwortliche Gruppe | Zugriff **Bearbeiten** auf die Base oder eine eigene Grids App für das Team | Bearbeitet alle Anfragen, ohne die Anfrage-App zu erweitern. |

Zugriff auf eine Grids App gibt keinen direkten Zugriff auf die Base. Die unveränderliche Veröffentlichung listet genau die Daten und Vorgänge auf, die anfragende Personen nutzen können. Probiere die Anfrage-App und die Oberfläche für das Team vor der Veröffentlichung mit getrennten echten Testkonten aus.

**Prüfpunkt:** Eine anfragende Person kann das Formular absenden, und die Datensatzabfrage der App liefert nur `record.createdBy = @auth.id`. Die verantwortliche Gruppe kann alle Anfragen über ihre eigene Grenze bearbeiten. Scheitert das, korrigiere die Abfrage oder trenne die Zielgruppen, bevor du weitere Seiten baust.

## Den Builder öffnen {icon="apps"}

Du brauchst Zugriff **Verwalten** auf die Base, um diese Steuerelemente zu sehen.

:::steps
1. Aktiviere den **Bearbeitungsmodus**.
2. Öffne die Base.
3. Wähle unter **Apps** die Option **Neue App**.
:::

Der Builder erstellt eine Startseite, die du umbenennen oder erweitern kannst. Du kannst dieselbe kanonische Definition auch mit [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli) erstellen oder ersetzen.

### Mit dem Entwurf arbeiten

Der Builder bearbeitet denselben kanonischen Entwurf wie YAML und die CLI. Er speichert jede strukturell vollständige Änderung automatisch. Semantische Diagnosen bleiben am Entwurf und blockieren die Veröffentlichung. Deine Arbeit geht dabei nie verloren.

Der Hinweis unter **Seiten** zeigt den Zustand des Entwurfs: **Diese App ist ein Entwurf**, **Änderungen befinden sich in einem Entwurf** oder **Verwendete Ressourcen wurden geändert**. Er zeigt Speicherfehler und veröffentlicht den zuletzt gespeicherten Entwurf. Er kann den Entwurf auch auf die aktuelle veröffentlichte Version zurücksetzen. Vorher fragt er nach, ob alle Änderungen am Entwurf verworfen werden dürfen. **Veröffentlichte App öffnen** öffnet die veröffentlichte Version.

Schlägt das Speichern fehl, wähle im Hinweis **Speichern erneut versuchen**. Folgst du im selben Tab einem Link zu einer anderen Cloud-Seite, wartet Grids zuerst, bis ausstehende Änderungen gespeichert sind. Das gilt auch, wenn du den **Bearbeitungsmodus** verlässt. Schlägt das Speichern fehl, bleibt der Builder offen. Lädst du den Tab neu oder schließt ihn, warnt der Browser vor ungespeicherten Änderungen. Brich die Warnung ab und versuche das Speichern erneut, um deine Änderungen zu behalten.

Kann eine Datenvorschau nicht geladen werden, wähle im betroffenen Block **Vorschau neu laden**. So versuchst du es erneut, ohne den Builder neu zu laden.

Diagramme zeigen Kategorien vom Typ Datum als lokalisierte Kalenderdaten. Textkategorien behalten ihre ursprüngliche Beschriftung, auch wenn sie wie ein Datum aussehen.

### Blöcke auf der Arbeitsfläche anordnen

Die Arbeitsfläche zeigt die aktuelle Entwurfsseite:

- Der Server löst die Ergebnisse gespeicherter Ansichten und von GQL ohne Parameter für die Entwurfsseiten auf.
- Datensätze verwenden die gemeinsame Datentabelle. Kennzahlen und Diagramme zeigen Aggregatergebnisse.
- Formulare verwenden die vollständige gemeinsame Formularoberfläche. Das Absenden ist während der Bearbeitung deaktiviert.
- Referenzierte Datensätze zeigen einen kontextbezogenen Platzhalter, weil ihr Ergebnis vom aktuellen Datensatz in der veröffentlichten Route abhängt. Gerendertes HTML folgt derselben Regel.

Zeige mit dem Mauszeiger auf einen Block oder fokussiere ihn, um seinen kompakten Verschiebegriff zu sehen. Ziehe den Block an eine horizontale Kante, um ihn vor oder nach einem anderen Block zu stapeln. Ziehe ihn an eine vertikale Kante, um ihn neben einen Block, ein benachbartes Paar oder den ganzen Stapel zu setzen. Zeiger, Berührung und Tastatur verwenden dieselben benannten Ziele und Ansagen. Grids erstellt und entfernt Zeilen, Spalten, leere Layoutcontainer und ausgeglichene Breiten automatisch. Du wählst und bearbeitest nur Blöcke.

**Block hinzufügen** gruppiert gewöhnliche Inhalte, Blöcke für den Seitendatensatz und erweiterte Einblicke und Aktionen. Ein Datenblock verwendet eine zugängliche gespeicherte Ansicht, wenn es eine gibt. Sonst beginnt er mit einer begrenzten GQL-Quelle aus einer verfügbaren Tabelle. Ein Block mit fehlenden Voraussetzungen bleibt im Menü sichtbar und erzeugt keinen unbrauchbaren Block.

### Die App konfigurieren

**App-Einstellungen** enthält **Allgemein**, **Zugriff** und **Lebenszyklus**. Änderungen an Name und Symbol verwenden denselben automatisch gespeicherten Entwurf. Wähle unter **Aktionen** einen vorhandenen Eintrag, um eine Formularaktion der Seitenleiste zu bearbeiten, oder wähle **Neue Aktion**, um eine hinzuzufügen. Im Inspektor stehen ihre Beschriftung, ihr Formular, feste Werte, Verfügbarkeit und Erfolgsnavigation. Inline-GQL und Markdown lassen sich in einem größeren Editor öffnen, ohne einen zweiten Entwurf oder einen eigenen Speicherschritt zu erzeugen.

Lege fest:

- **Name:** Zertifikatsanfragen
- **Symbol:** Zertifikat
- **Startseite:** Antrag

Erstelle diese Seiten und prüfe und verfeinere sie danach im Builder:

| Seiten-ID | Titel | Navigation | Parameter |
| --- | --- | --- | --- |
| `apply` | Antrag | Sichtbar | Keine |
| `requests` | Meine Anfragen | Sichtbar | Keine |
| `request` | Anfragedetails | Verborgen | Erforderlicher Parameter `request_id`, Typ Record, Tabelle Zertifikatsanfragen |

Seiten-IDs sind stabile Kennungen der Definition. Du kannst sie in den **Seiteneinstellungen** bearbeiten. Der Builder aktualisiert dann die Navigationsverweise atomar. Bezeichnungen können sich ändern, ohne die Navigation zu unterbrechen. Personen erreichen die verborgene Detailseite über eine Zeile oder nach erfolgreichem Absenden des Formulars.

**Prüfpunkt:** Der Entwurf öffnet Antrag, zeigt Antrag und Meine Anfragen in der Navigation und hält Anfragedetails heraus. Korrigiere andernfalls die Startseite, die Sichtbarkeit jeder Seite und die Reihenfolge im Seitenarray.

## Die Seite Antrag erstellen {icon="forms"}

:::steps
1. Füge eine Zeile über die volle Breite hinzu.
2. Füge einen Markdown-Block hinzu, der die benötigten Informationen und die erwartete Bearbeitungszeit erklärt.
3. Füge einen Formularblock mit **Zertifikat anfragen** hinzu.
4. Setze in **Nach dem Absenden** des Formularblocks die **Zielseite** auf `request`.
5. Binde `request_id` an **Vom Formular erstellter Datensatz**.
:::

Die Bindung lautet:

```text
request_id = RESULT.recordId
```

Ein erfolgreiches Absenden ersetzt den Verlaufseintrag. Zurück führt deshalb nicht zum abgeschlossenen Absenden. Das Formular behält Pflichtfelder, Validierung, festen Status und Datensatzerstellung.

**Prüfpunkt:** Nach erfolgreichem Absenden öffnet sich die Detail-URL der neuen Anfrage. Gelingt die Erstellung, aber nicht die Navigation, korrigiere die Erfolgsbindung, nicht das Formular.

## Die Seite Meine Anfragen erstellen {icon="list-details"}

Füge einen Datensatzblock mit der gespeicherten Ansicht **Meine Zertifikatsanfragen** hinzu. Zeige nur die Felder, die eine Anfrage erkennbar machen. Nutze je nach erwarteter Bildschirmbreite eine kompakte Tabelle oder Karten.

Setze **Zeile auf Seite öffnen** auf `request` und binde:

```text
request_id = ROW.id
```

Das veröffentlichte GQL muss `record.createdBy = @auth.id` in der Quelle behalten, die der Server ausführt. Die Zeilen, die die Tabelle zeigt, sind Darstellung und nie Zugriffskontrolle.

**Prüfpunkt:** Die Auswahl einer sichtbaren Zeile öffnet ihre Detailseite. Änderst du die URL auf eine andere Anfrage, legt das diesen Datensatz nicht offen. Korrigiere Zeilennavigation und Zeilenautorisierung getrennt.

## Die Seite Anfragedetails erstellen {icon="file-description"}

Füge unter **Routenparameter** einen Record-Parameter mit der ID `request_id` und der Tabelle **Zertifikatsanfragen** hinzu. Ergänze danach den Datensatzblock. Der Builder bindet denselben Routenparameter automatisch als Seitendatensatz. Eine eigene Einstellung für den Seitendatensatz gibt es nicht:

```text
PARAMS.request_id
```

Ordne die Seite in der Reihenfolge der Aufgabe:

1. Ein Datensatzblock mit Titel, Status, Bearbeitungshinweis und den eingereichten Details.
2. Ein Kommentarblock für den Seitendatensatz.
3. Erzeugte Dokumente im Datensatzblock, begrenzt auf die Vorlage Zertifikat.
4. Ein Aktionsblock, nur wenn die aktuelle Zielgruppe einen passenden aktivierten Workflow-Launcher hat.

Felder der anfragenden Person sind nach dem Absenden normalerweise schreibgeschützt. Sind Korrekturen erlaubt, füge nur diese Felder unter **Bearbeitbare Felder** hinzu. Status, Genehmigungsdaten und erzeugte Ausgaben bleiben beim Workflow.

Fehlt der Seitendatensatz, kann der Datensatzblock einen konfigurierten Leertext zeigen. Eine vorhandene Anfrage ohne erzeugtes Zertifikat hat keinen Download-Eintrag. Das aktuelle Schema kennt keinen eigenen Leertext für Dokumente.

**Prüfpunkt:** Status, Kommentare und erzeugte Dokumente bleiben nach dem Neuladen mit derselben Anfrage verknüpft. Ein Fehler gehört zur Datensatzbindung, zum Zugriff auf Kommentare oder zu dem Dokument, das der fehlerhafte Block nennt.

## Die Bearbeitung außerhalb des Layouts halten {icon="route"}

Die verantwortliche Gruppe kann Anfragen im Grids-Arbeitsbereich oder in einer zweiten gewöhnlichen Grids App bearbeiten. Ein besonderer App-Typ für die Administration ist nicht nötig.

Der Workflow muss die Anfrage erneut lesen und validieren, bevor er sie ändert. Zusammengehörige Datensatzänderungen nutzen die atomare Grenze des Workflows für Datensatzänderungen. Externe Auswirkungen beginnen erst, wenn diese Änderungen gespeichert sind. So können gleichzeitig prüfende Personen keinen veralteten Übergang unbemerkt anwenden.

## Den vollständigen Ablauf testen {icon="shield-check"}

Speichere den Entwurf. Gib nur eigenen Testkonten Zugriff, je eines für jede Zielgruppe. Prüfe dann:

:::steps
1. Sende als anfragende Person eine gültige Anfrage. Prüfe, dass sich ihre Detailseite sofort öffnet.
2. Lade die Detail-URL neu. Prüfe, dass sich dieselbe Anfrage öffnet.
3. Verwende eine andere Anfrage-ID. Prüfe, dass weder der Datensatz noch seine Existenz offengelegt wird.
4. Prüfe die Zustände: leere Liste, keine Kommentare, ausstehendes Dokument, abgeschlossen, fehlender Parameter und verweigert.
5. Prüfe als verantwortliche Gruppe, dass die vorgesehenen Datensätze und Aktionen für die Bearbeitung verfügbar sind.
6. Wiederhole den Ablauf auf breiten und schmalen Bildschirmen mit Tastaturnavigation.
:::

Die App ist bereit, wenn eine anfragende Person den Ablauf ohne Grids-Arbeitsbereich und ohne Kenntnis der Tabelle dahinter versteht. Der Builder hat keinen Modus, um als jemand anderes aufzutreten, und keine anonyme Vorschau. Teste öffentlichen Zugriff nur mit einer Test-App, die du bewusst veröffentlichst.

## Eine App offline nehmen oder löschen {icon="alert-triangle"}

:::warning Das Löschen lässt sich im Builder nicht rückgängig machen
Nachdem du **App löschen** bestätigt hast, kann der Builder die App nicht wiederherstellen.
:::

Öffne **App-Einstellungen → Lebenszyklus**:

- **App nicht mehr veröffentlichen** entfernt den veröffentlichten Snapshot sofort. Entwurf und Zugriffseinträge bleiben, sodass du die App später bearbeiten und erneut veröffentlichen kannst.
- **App löschen** entfernt die App und ihre veröffentlichte URL. Tabellen und Datensätze der Base löscht es nicht.

Beide Aktionen fragen nach einer Bestätigung, bevor sich etwas ändert.

## Veröffentlichen und prüfen {icon="rocket"}

:::steps
1. Führe die Vorabprüfung zur Veröffentlichung aus.
2. Prüfe jede angeforderte Capability.
3. Veröffentliche die App.
4. Öffne die eigenständige URL.
5. Wiederhole den Ablauf der anfragenden Person mit dem veröffentlichten Snapshot.
:::

Scheitert etwas, korrigiere die zuständige Ebene:

| Problem | Zuständige Ebene |
| --- | --- |
| Fehlende oder ungültige `request_id` | Seitenparameter oder Navigationsbindung |
| Fehlende oder nicht verfügbare Anfrage | Veröffentlichte Abfrage, Seitenparameter oder `availableWhen` |
| Abgelehnte Eingabe | Formular |
| Veralteter Übergang oder teilweise Datensatzänderung | Workflow |
| Fehlendes PDF | Dokumentvorlage oder Dokument |
| Nicht verfügbare Aktion | Veröffentlichte Capability, Launcher-Status oder Zugriff |

Lies [Seiten und Blöcke in Grids Apps](/app/grids/help/grids-custom-app-pages-blocks) für alle Einstellungen, [Grids App veröffentlichen](/app/grids/help/grids-publish-custom-app) für die Vorabprüfung und [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli) für denselben Ablauf für Agenten.
