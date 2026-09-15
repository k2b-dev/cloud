---
id: grids-camt
title: Bankberichte lesen (CAMT)
icon: ti ti-file-analytics
description: Bankdateien erfassen, Kontoberichte prüfen und Originale behalten, ohne Zahlungen zu buchen.
order: 153
---
Die Workflow-Aktion `parseDocument` liest **camt.052.001.08** aus einem Datei-Feld. Grids speichert die Originaldatei zusammen mit ihren strukturierten Kontoberichten. Es legt keine Zahlungen an, markiert keine Rechnungen als bezahlt, ordnet keine Buchungen zu und führt keine Berichtsseiten zusammen.

## Mit einem Datei-Feld beginnen

Erstelle beispielsweise eine Tabelle **Bankimporte** mit dem Datei-Feld **Bankdatei**. Verwende bei Bedarf `maxFiles: 1` und `.xml` als erlaubten Dateityp. Lade die Bankdatei über den normalen Datensatz oder ein Formular hoch. Bei keiner oder mehreren Dateien bricht die Aktion ab, statt eine auszuwählen.

Veröffentliche einen Workflow mit den Tabellen- und Feldnamen deiner Base:

```yaml
inputs:
  selected:
    type: record
    table: Bankimporte
    required: true
steps:
  - parseDocument:
      record: inputs.selected
      field: Bankdatei
      format: camt.052.001.08
      saveAs: bank
  - generateDocument:
      data: bank
      output:
        kind: json
```

`record` ist eine Datensatzreferenz, kein interpoliertes Objekt und keine frei eingesetzte Datei-ID. `field` muss ein Datei-Feld der angegebenen Tabelle sein. Beim Veröffentlichen werden diese Abhängigkeiten gebunden. Es gelten die normalen Base-Berechtigungen des Workflows.

Ein Probelauf prüft die Datensatzreferenz, liest und validiert aber keine Datei und erzeugt keinen gespeicherten Stand oder Export. Teste vor der Nutzung einen echten Lauf mit einer repräsentativen Datei.

## Das Ergebnis verstehen

`saveAs: bank` erhält eine kleine, unveränderliche Referenz. Die API stellt sie im Schrittergebnis so dar:

```json
{"kind":"fileSnapshot","stepKey":"steps.0","sha256":"<capture hash>","rowCount":2,"capturedAt":"2026-09-15T12:00:00.000Z"}
```

Die öffentliche Referenz verwendet die Short-ID des Laufs und `stepKey`. Capture-UUIDs bleiben intern. `sha256` sichert den gesamten Stand ab; das Original hat einen eigenen Hash. `rowCount` zählt Kontoberichte, **nicht Buchungen oder Einzeltransaktionen**.

Übergib `data: bank` direkt an `generateDocument`. Wie bei einer erfassten Abfrage enthält `data.rows` in einer Vorlage eine Zeile je Ergebnis, jeweils mit einem `report`-Objekt. Der allgemeine JSON-Export bewahrt diese Struktur. Das ist keine flache Buchungstabelle für CSV.

Erhalten bleiben die gelieferten Kontokennungen, Berichtszeiträume, Salden, Buchungen, Transaktionsdetails und Referenzen. Wichtig:

- Beträge bleiben Dezimalstrings mit Währung. Rechne nicht mit binären Fließkommazahlen weiter.
- `CRDT` und `DBIT` bleiben getrennt vom positiven Betrag. Grids macht aus einer Belastung nicht stillschweigend eine negative Zahl.
- Status wie `BOOK` oder `PDNG` und Storno-Kennzeichen bleiben erhalten. Ein eingelesener Eintrag ist keine Zahlungsbestätigung.
- Eine Buchung kann mehrere Transaktionsdetails enthalten. Fehlende Einzelbeträge bleiben fehlend; Grids verteilt den Gesamtbetrag nicht auf die Details.
- Nachricht und Kontobericht können eigene Seitenangaben haben. `lastPage: false` bedeutet, dass weitere Seiten existieren. Ohne Seitenangaben ist die Vollständigkeit unbekannt.
- `complete: true` im gespeicherten Stand bedeutet nur, dass die vorliegende Datei ohne Abschneiden erfasst wurde – nicht, dass die Bank alle Seiten geliefert hat.

## Ansehen oder herunterladen

Öffne den Workflow-Lauf, erweitere den abgeschlossenen Schritt `parseDocument` und wähle **Bankbericht ansehen**. Die Übersicht zeigt jeweils einen Kontobericht mit Anzahl der Buchungen, Status und Seitenangaben. Unter **Berichtsdetails** stehen die strukturierten Daten. **Originaldatei** lädt die exakten hochgeladenen XML-Bytes herunter, auch wenn der Anhang später vom Datensatz gelöst wurde.

Die CLI bietet denselben lesenden Zugriff:

```sh
cld grids workflow-runs steps <run>
cld grids workflow-runs file <run> <step-key> --sha256 <capture-hash>
cld grids workflow-runs file <run> <step-key> --sha256 <capture-hash> --json
cld grids workflow-runs download-file <run> <step-key> --sha256 <capture-hash> --out bank.xml
```

Die API lautet `GET /api/grids/workflows/runs/:runId/files/:stepKey?sha256=...`. Übernimm `stepKey` URL-kodiert aus dem Schrittergebnis. Mit `&download=original` erhältst du XML. Beide Zugriffe prüfen die Berechtigung für die Base des Laufs. Der Stand ist nicht über andere Läufe oder Bases erreichbar. Die JSON-Antwort enthält die Berichte, nicht die Base64-Kopie des Originals.

## Unterstützter Umfang und Grenzen

Unterstützt sind ausschließlich UTF-8-XML, optional mit UTF-8-BOM, und `camt.052.001.08`. Andere CAMT-Namensräume, auch 053 und 054, werden abgelehnt. Ändere den Namensraum einer Bankdatei nicht, um den Import zu erzwingen.

Der Parser lehnt fehlerhaftes XML und DTDs ab und prüft die unterstützte Struktur. Das ist weder ein Bankabgleich noch eine Zusage vollständiger XSD- oder fachlicher Zertifizierung.

Das bestehende **kumulative Limit von 5 MiB je Workflow-Lauf** umfasst das Base64-Original und das eingelesene JSON sowie weitere gespeicherte Datenstände des Laufs. Deshalb kann bereits eine kleinere Datei das Limit überschreiten. Es wird nichts abgeschnitten. Verwende bei Bedarf kleinere Bankberichte.

Ein Bankbericht ordnet den erzeugten Export nicht automatisch jedem Datensatz zu, dessen Kennung im XML steht. [Dokumentzuordnungen](/app/grids/help/grids-documents-pdfs) entstehen aus explizit erfassten Datensatzdaten, nicht aus vermuteten Bankreferenzen.

Weiter: [Workflows](/app/grids/help/grids-workflows), [Dateien und Dokumente](/app/grids/help/grids-documents-pdfs), [Berechtigungen](/app/grids/help/grids-permissions).
