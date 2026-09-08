---
id: grids-documents-pdfs
title: Dokumente und PDFs
icon: ti ti-file-type-pdf
description: PDFs aus gespeicherten Datensätzen erstellen, generieren, organisieren und teilen.
order: 135
---
Dokumentvorlagen verwandeln Tabellendatensätze in wiederholbar erzeugbare PDFs. Nutze sie für Rechnungen, Verträge, Etiketten, Zertifikate, Lieferscheine, Angebote, Packlisten, Checklisten und Datensatzübersichten.

Jede Vorlage gehört zu einer Tabelle und definiert eine Dokumentfamilie. Ein generiertes Dokument gehört zu einem ausgewählten Datensatz, erhält eine stabile Nummer und einen stabilen Dateinamen und bewahrt den exakten Quell-Snapshot, nachdem sich die aktiven Datensätze geändert haben. Es erscheint im Bereich Dokumente des Datensatzes, im Arbeitsbereich seiner Vorlage und im basisweiten Katalog **Alle Dokumente**.

Nutze eine Dokumentvorlage, wenn die Ausgabe für Personen formatiert, gedruckt, über einen ablaufenden Link geteilt oder später erneut heruntergeladen werden soll. Nutze einen CSV- oder JSON-Export, wenn du nur Daten für ein anderes System benötigst.

## Ein unveränderliches Dokumentmodell {icon="shield-check"}

Agents finden mit `document.templates` Vorlagen, lesen mit `document.list` und `document.read` gespeicherte Dokumente und stellen mit `document.create` ein Dokument für einen ausgewählten Record aus. Dafür sind Schreibzugriff, ein Idempotenzschlüssel und eine einzelne ausdrückliche Bestätigung nötig. Die Ausstellung ist nicht rückgängig zu machen und erlaubt keine dauerhafte Pauschalfreigabe. Der Download-Link benötigt weiterhin deine Berechtigungen; er erstellt keinen öffentlichen Freigabelink und versendet das Dokument nicht.

Jedes abgeschlossene Dokument ist unveränderlich. Es gehört zu einer Vorlage und einem ausgewählten Datensatz. Dasselbe Dokument erscheint in Datensatzdetails, Vorlagenarbeitsbereich und **Alle Dokumente**. Eine wiederholte Generierung mit demselben Idempotenzschlüssel gibt dasselbe Dokument zurück; die Wiederverwendung dieses Schlüssels mit anderer Eingabe scheitert.

Scheitert die Erzeugung, sendet **Erzeugung wiederholen** die ursprünglichen Eingaben erneut. Hat die Erzeugung ihre Quelldaten bereits gespeichert, verwenden Wiederholungen diese Daten auch nach Änderungen am Datensatz oder an der Vorlage. Der Dialog sperrt die Eingaben und blendet die Live-Vorschau aus. Wähle **Neuen Versuch starten**, um Eingaben zu korrigieren oder aktuelle Daten zu verwenden, und erstelle die Vorschau erneut. Prüfe zuerst **Alle Dokumente**: Der vorherige Versuch hat möglicherweise bereits ein Dokument erstellt, und ein neuer Versuch kann ein weiteres erzeugen. Personen mit Schreibzugriff können vorhandene Dokumentlinks auch verwalten, wenn die Vorlage deaktiviert oder nicht mehr verfügbar ist.

Eine Vorlage wählt einen Renderer aus. Der HTML-Renderer wandelt Liquid-HTML und CSS in ein PDF um. Ein installierter E-Rechnungs-Renderer ordnet den ausgewählten Datensatz über Liquid-JSON zu und erstellt und validiert anschließend PDF und strukturiertes Artefakt gemeinsam. Der Renderer verändert die Artefakte eines Dokuments, nicht das Dokumentmodell oder die Art, wie es generiert, aufgelistet, geprüft oder heruntergeladen wird.

Die Validierung belegt nur die technischen Prüfungen, die der gewählte Renderer und seine Version benennen. Sie ist keine allgemeine steuerliche, buchhalterische, Signatur-, Aufbewahrungs- oder Rechtskonformitätsentscheidung. Rufe mit `cld grids documents renderers --json` die auf dieser Installation verfügbaren Renderer ab.

Der integrierte Renderer `de.zugferd.en16931@1` erstellt ausgehende EUR-Rechnungen als lesbares PDF/A-3b mit eingebettetem `factur-x.xml` und bewahrt die XML-Datei als getrenntes Artefakt auf. Er prüft nach dem Rendern die eingebettete XML-Datei, zielt auf ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, validiert das erzeugte CII-XML gegen das festgeschriebene XSD und verwendet exakte Dezimalzeichenfolgen mit dokumentierter kaufmännischer Rundung. Version 1 unterstützt deutsche Anschriften für verkaufende und kaufende Organisationen, Standard-Mehrwertsteuerkategorien und Banküberweisung. Korrekturen, Ersatzbelege, eingehende Rechnungen, Fremdwährungen, Steuerbefreiungen, Nachlässe, Zuschläge, Vorauszahlungen, Skonto, Selbstfakturierung oder Meldungen werden nicht unterstützt. Der Rechnungsaussteller verantwortet den Inhalt und prüft, ob dieser Renderer für den vorgesehenen Einsatz geeignet ist. Grids bestätigt keine steuerliche oder rechtliche Konformität.

## Vom Datensatz zum PDF {icon="table"}

Die Vorlage trennt Datenauswahl und Rendering. **GQL** lädt die Zeilen und Spalten, die das Dokument verwenden darf. Der ausgewählte Renderer erhält anschließend entweder Liquid-HTML und CSS oder ein Liquid-JSON-Objekt.

**Pipeline**

```text
selected record
  -> fill record values into the GQL source
  -> run the GQL query
  -> render the selected HTML or E-Invoice input
  -> create and validate the artifacts
  -> save the Document and source snapshot
```

Lege Filterung, Sortierung, Joins, Gruppierung und Summen in GQL ab. Beschränke Liquid auf Formulierung und Seitenlayout.

Wähle bei einer E-Rechnungsvorlage den Renderer aus und ordne die Vorschaudaten unter **Renderer-Eingabe** zu. Der Editor erwartet ein JSON-Objekt. Nutze für jeden eingesetzten Wert den Filter `json`, zum Beispiel `"buyerReference": {{ record.id | json }}`, damit Anführungszeichen und andere Zeichen gültiges JSON bleiben. Die Vorschau führt Validierung und PDF-Erzeugung dieses Renderers aus, bevor die Vorlage aktiviert wird.

## Erste Vorlage erstellen {icon="file-description"}

:::steps
1. **Vorlagen öffnen:** Öffne die Tabelle im Bearbeitungsmodus und wähle Vorlagen. Vorlagen gehören zu der Tabelle, für die sie Dokumente erzeugen.
2. **Starter wählen:** Wähle die Struktur, die der benötigten Ausgabe am nächsten kommt. Jeder Starter bleibt vollständig bearbeitbar.
3. **Vorschaudatensatz auswählen:** Derselbe Datensatz bildet den Anker für gerendertes GQL, Datenbaum und PDF-Vorschau.
4. **Vor dem Bearbeiten prüfen:** Quelle zeigt das GQL nach dem Einsetzen der Datensatzwerte. Daten zeigt die exakten Liquid-Pfade. Vorschau zeigt das PDF.
5. **Jeweils eine Ebene ändern:** Passe GQL bei falschen Daten an. Passe Inhalt, Kopfzeile, Fußzeile oder Seiten-CSS bei falschem Layout an.
6. **Repräsentative Daten als Vorschau prüfen:** Teste lange Texte, fehlende Werte, viele Zeilen und Seitenumbrüche. Neue Vorlagen sind im Editor zunächst deaktiviert.
7. **Aktivieren und testen:** Personen mit Schreibzugriff auf die Basis können anschließend einen Datensatz auswählen und ein gespeichertes Dokument generieren.
:::

Der ausgewählte Vorschaudatensatz ist nur Testkontext. Beim späteren Generieren wählen Personen den tatsächlichen Datensatz aus und können Dateinamen überschreiben oder Tags ergänzen.

## Starter {icon="square-plus"}

Starter sind bearbeitbare Vorlagen und keine festen Dokumenttypen. Wähle die nächstliegende Struktur und ändere anschließend GQL-Quelle und Liquid-Teile, bis das erzeugte PDF zu den Datensätzen der Tabelle passt.

- `Leere Vorlage`
- `Rechnung`
- `Leihvertrag`
- `Etikett`
- `QR-Etikett`
- `Übersichtsbericht`
- `Datensatzdetails`
- `Lieferschein`
- `Angebot`
- `Packliste`
- `Zertifikat`
- `Checkliste`
- `Namensschild`

## Bearbeitbare Teile {icon="table"}

Eine Vorlage besitzt einen Datenteil und bis zu vier Layoutteile. Die GQL-Quelle wird zuerst mit Liquid gerendert. Dadurch kann sie Werte des ausgewählten `record`, der öffentlichen `app` und der gemeinsamen Basiswerte `business` verwenden, bevor die Abfrage geparst wird.

| Teil       | Sprache       | Zweck                                                                                                   | Häufige Verwendung                                                                     |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GQL-Quelle | Liquid + GQL  | Wählt die für das Dokument verfügbaren Zeilen und Spalten aus. Liquid wird vor dem Parsen von GQL gerendert. | Aktueller Datensatz, verbundene Zeilen, Elementlisten, gruppierte Zusammenfassungen.    |
| Inhalt     | Liquid + HTML | Hauptinhalt zum Drucken für den HTML-Renderer.                                                           | Rechnungsinhalt, Vertragsklauseln, Etikettenlayout, Tabellen mit Datensatzdetails.      |
| Kopfzeile  | Liquid + HTML | Optionale Kopfzeile auf jeder Seite.                                                                    | Briefkopf, Absenderidentität, Dokumentklasse, Kontaktblock.                             |
| Fußzeile   | Liquid + HTML | Optionale Fußzeile auf jeder Seite.                                                                     | Rechtliche Fußzeile, Bankdaten und Seitenplatzhalter wie `<span class="pageNumber"></span>` und `<span class="totalPages"></span>`. |
| Seiten-CSS | Liquid + CSS  | Optionales CSS, das in den PDF-Inhalt eingefügt wird.                                                   | @page-Größe/-Ränder, Tabellenköpfe, Seitenumbrüche, Drucktypografie.                    |

## Verfügbare Daten verstehen {icon="layout-grid"}

Der Tab Daten ist die maßgebliche Quelle für den aktuellen Vorschaudatensatz. Er zeigt die exakte Struktur, die Liquid nach der Ausführung der GQL-Quelle erhält. Kopiere Pfade aus diesem Baum, statt Objektstrukturen zu erraten.

Betrachte die Daten in Ebenen: `record` ist der ausgewählte Datensatz, `rows` und `columns` sind das GQL-Ergebnis und `document` beschreibt ein gespeichertes Dokument. `template`, `document` und `date` liefern stabile Metadaten für Nummern und Dateinamen. `app` enthält öffentliche Plattformwerte für die Darstellung. `business` enthält die gemeinsamen Dokumentangaben der Basis. Zeilen stellen zusätzlich GQL-Ausgabebezeichnungen bereit, weshalb lesbare Aliasse Vorlagen leichter wartbar machen.

:::reference
- **record:** Der aktuelle Datensatz: öffentliche `record.id` und `record.tableId`, `record.version`, `record.data` sowie Erstellungs- und Aktualisierungszeitpunkte.
- **rows und columns:** Die von der GQL-Quelle zurückgegebenen Zeilen und Spalten. Nutze `column.key` für Zeilenzugriff und `column.label` für lesbare Überschriften.
- **template, document, date:** Stabile Metadaten für Muster und Dokumenttext: `{{ template.name }}`, `{{ template.id }}`, `{{ document.id }}`, `{{ date.iso }}` und `{{ date.yyyyMMdd }}`. Entwurfsvorschauen verwenden Entwurfswerte des Dokuments, bis ein Dokument existiert.
- **app:** Öffentliche Plattformwerte für die Dokumentdarstellung: `{{ app.name }}`, `{{ app.contactEmail }}`, `{{ app.url }}`, `{{ app.logoDataUri }}` und `{{ app.timezone }}`.
- **business:** Dokumentangaben der Basis wie `{{ business.legalName }}`, `{{ business.senderLine }}`, `{{ business.address }}`, `{{ business.paymentTerms }}`, `{{ business.iban }}` und Fußzeilen-/Kontaktfelder. Bearbeite sie unter Basiseinstellungen → Dokumente.
- **images:** Bilddateien, die an Dateifelder des ausgewählten Datensatzes angehängt sind. Nutze `{{ primaryImage.url }}` für das erste unterstützte Bild oder durchlaufe `images`. Zu große und nicht unterstützte Dateien werden ausgelassen.
- **document:** Dokumentmetadaten wie `{{ document.number }}` und `{{ document.createdAt }}`. Nutze sie in Dateinamen und Inhalt/Kopf-/Fußzeilen-HTML, nachdem das Nummernmuster gerendert wurde. Entwurfsvorschauen besitzen möglicherweise noch keine endgültigen Werte.
- **snapshot:** Der erfasste Datensatzgraph für ein generiertes Dokument. In aktiven Entwurfsvorschauen ist er `null`.
- **barcode_data_url:** Ein Grids-Liquid-Filter für Etiketten und Ausweise. Er gibt eine SVG-Daten-URL für QR-Codes und unterstützte BWIP-Barcodesymbole zurück.
:::

## Muster für GQL-Quellen {icon="code"}

Lege Filterung, Sortierung, Joins, Gruppierung und Grenzen in GQL ab. Beschränke Liquid auf die Darstellung.

**Nur aktueller Datensatz**

```gql
from table Invoices
where record.id = '{{ record.id }}'
limit 1
```

**Aktueller Datensatz mit Namen verknüpfter Elemente**

```gql
from table Loans
left join table Items as item on Items = item.id
select "Loan number", Borrower, item.Name as item_name, item.Condition as item_condition
where record.id = '{{ record.id }}'
sort item.Name asc
```

**Batch oder Checkliste**

```gql
from table Items
select Name, Status, Location
where Status = 'Ready'
sort Name asc
limit 100
```

## Nummern und Dateinamen {icon="paperclip"}

Ein generiertes Dokument besitzt eine stabile `document.number`. Eine HTML-Vorlage besitzt einen dauerhaften Nummernkreis. Ihr Nummernmuster wird zuerst gerendert; ihr Dateinamenmuster kann anschließend `{{ document.number }}` verwenden. Ein E-Rechnungs-Renderer besitzt seine Nummerierung und Artefaktnamen selbst.

Das Standard-HTML-Nummernmuster lautet `{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}`. Ein eigenes Muster kann die vergebene `{{ series.value }}` verwenden. Vergaben steigen atomar und werden nie wiederverwendet, aber Rollbacks und technische Fehler können Lücken hinterlassen. Grids behauptet nicht, dass ein Nummernmuster allein Rechtskonformität herstellt.

**Standardnummer**

```text
{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}
```

**Standarddateiname**

```text
{{ document.number }}.pdf
```

**Geschäftliche Nummer**

```text
INV-{{ date.yyyy }}-{{ document.id }}
```

**Fortlaufende Nummer**

```text
INV-{{ date.yyyy }}-{{ series.value }}
```

**Lesbarer Dateiname**

```text
invoice-{{ record.data.Name | default: document.number }}-{{ document.number }}.pdf
```

:::reference
- **Kontext des Nummernmusters:** Darf `record`, `table`, `template`, `document`, `series`, `date`, `app` und `business` verwenden. `series.id` ist die öffentliche ID des Nummernkreises, `series.value` die vergebene Nummer. `document.id` ist bereits verfügbar; `document.number` wird erst berechnet und ist noch nicht verfügbar.
- **Kontext des Dateinamenmusters:** Darf den vollständigen gerenderten Datenbaum einschließlich `{{ document.number }}` verwenden. Der endgültige Dateiname wird für sichere PDF-Downloads im Dateisystem bereinigt.
- **Validierung:** Unbekannte Liquid-Variablen auf oberster Ebene, ungültige Tags, nicht unterstützte Filter, leere Muster und zu große Muster lassen das Speichern der Vorlage scheitern.
:::

## Liquid-Referenz {icon="book-2"}

Vorlagenteile verwenden Liquid mit Grids-Einschränkungen: strikte Variablen, strikte Filter, maskierte Ausgabe, keine Layouts, keine dynamischen Partials und nur die unten aufgeführten Tags. Unbekannte Filter, ungültige Tags und zu große Ausgaben scheitern, statt ein Teildokument zu erzeugen.

:::reference
- **Ausgabe:** Gib mit `{{ value }}` einen Wert aus. Die Ausgabe wird standardmäßig für HTML maskiert. Nutze `| raw` nur, wenn eine vertrauenswürdige Vorlage bewusst HTML ausgibt.
- **Filter:** Leite Werte durch Filter, zum Beispiel `{{ row.Name | default: '-' }}`. Unbekannte Filter führen zu einem Fehler.
- **Bedingungen:** Nutze `{% if row.Status == 'Open' %}`, `elsif`, `else` und `endif`.
- **Schleifen:** Nutze `{% for row in rows %}` und `{% endfor %}`. `break` und `continue` sind erlaubt.
- **Temporäre Werte:** Nutze `assign` für kurze Werte und `capture` für längere gerenderte Fragmente.
- **Keine externen Partials:** `include`, `render`, `layout` und Tags für externe Partials sind nicht erlaubt. Eine Vorlage muss eigenständig sein.
:::

Erlaubte Tags

- `if`
- `elsif`
- `else`
- `endif`
- `unless`
- `endunless`
- `for`
- `break`
- `continue`
- `endfor`
- `case`
- `when`
- `endcase`
- `assign`
- `capture`
- `endcapture`
- `comment`
- `endcomment`
- `raw`
- `endraw`

## Barcodes und QR-Codes {icon="code"}

Nutze den Filter `barcode_data_url` in einem `<img>`-Tag. Barcode-IDs sind kleingeschriebene Symbole. Das optionale dritte Argument steuert lesbaren Text für Barcodeformate, die ihn unterstützen.

**Code 128 mit Text**

```text
{% if rows.size > 0 and columns.size > 0 %}
  {% assign first = rows[0] %}
  {% assign codeColumn = columns[0] %}
  {% assign codeValue = first[codeColumn.key] | default: table.name %}
{% else %}
  {% assign codeValue = table.name %}
{% endif %}
<img src='{{ codeValue | barcode_data_url: "code128", true }}' alt="Asset barcode">
```

**QR-Code**

```html
<img src='{{ document.number | default: table.name | barcode_data_url: "qrcode" }}' alt="Document QR code">
```

| Typ-ID            | Bezeichnung         | Verwendung                              |
| ----------------- | ------------------- | --------------------------------------- |
| `code128`         | Code 128            | Allgemeiner linearer Barcode.           |
| `qrcode`          | QR Code             | Kompakter 2D-Code für Mobilgeräte.      |
| `datamatrix`      | Data Matrix         | Kleiner 2D-Code für Etiketten.          |
| `pdf417`          | PDF417              | Gestapelter 2D-Code für Dokumente.      |
| `azteccode`       | Aztec Code          | Dichter 2D-Code ohne Ruhezone.          |
| `ean13`           | EAN-13              | Produktcode für den Einzelhandel, 13 Ziffern. |
| `ean8`            | EAN-8               | Kurzer Produktcode für den Einzelhandel. |
| `upca`            | UPC-A               | US-Produktcode für den Einzelhandel.    |
| `upce`            | UPC-E               | Komprimierter UPC-Code.                 |
| `itf14`           | ITF-14              | Code für Kartons und Verpackungen.      |
| `gs1datamatrix`   | GS1 Data Matrix     | GS1-2D-Code mit Anwendungs-IDs.         |
| `sscc18`          | SSCC-18             | Code für Versandbehälter.               |
| `isbn`            | ISBN                | Barcode für Buchkennungen.              |
| `issn`            | ISSN                | Barcode für fortlaufende Publikationen. |
| `ismn`            | ISMN                | Barcode für gedruckte Musik.            |
| `code39`          | Code 39             | Einfacher alphanumerischer Barcode.     |
| `code93`          | Code 93             | Kompakter alphanumerischer Barcode.     |
| `interleaved2of5` | Interleaved 2 of 5  | Numerischer Lagerbarcode.               |
| `micropdf417`     | MicroPDF417         | Kompakter gestapelter 2D-Code.          |
| `microqrcode`     | Micro QR Code       | Kleine QR-Variante.                     |
| `maxicode`        | MaxiCode            | 2D-Code für Pakete und Logistik.        |
| `dotcode`         | DotCode             | Punktbasierter Produktionscode.         |

Zusätzliche BWIP-Symbol-IDs

- `auspost`
- `azteccodecompact`
- `aztecrune`
- `bc412`
- `channelcode`
- `codablockf`
- `code11`
- `code16k`
- `code2of5`
- `code32`
- `code39ext`
- `code49`
- `code93ext`
- `codeone`
- `coop2of5`
- `d3aqr`
- `daft`
- `databarexpanded`
- `databarexpandedcomposite`
- `databarexpandedstacked`
- `databarexpandedstackedcomposite`
- `databarlimited`
- `databarlimitedcomposite`
- `databaromni`
- `databaromnicomposite`
- `databarstacked`
- `databarstackedcomposite`
- `databarstackedomni`
- `databarstackedomnicomposite`
- `databartruncated`
- `databartruncatedcomposite`
- `datalogic2of5`
- `datamatrixrectangular`
- `datamatrixrectangularextension`
- `ean13composite`
- `ean14`
- `ean2`
- `ean5`
- `ean8composite`
- `flattermarken`
- `gs1datamatrixrectangular`
- `gs1dldatamatrix`
- `gs1dlqrcode`
- `gs1dotcode`
- `gs1northamericancoupon`
- `gs1qrcode`
- `hanxin`
- `hibcazteccode`
- `hibccodablockf`
- `hibccode128`
- `hibccode39`
- `hibcdatamatrix`
- `hibcdatamatrixrectangular`
- `hibcmicropdf417`
- `hibcpdf417`
- `hibcqrcode`
- `iata2of5`
- `identcode`
- `industrial2of5`
- `japanpost`
- `kix`
- `leitcode`
- `mailmark`
- `mands`
- `matrix2of5`
- `msi`
- `onecode`
- `pdf417compact`
- `pharmacode2`
- `pharmacode`
- `planet`
- `plessey`
- `posicode`
- `postnet`
- `pzn`
- `rectangularmicroqrcode`
- `royalmail`
- `swissqrcode`
- `symbol`
- `telepen`
- `telepennumeric`
- `ultracode`
- `upcacomposite`
- `upcecomposite`

## Liquid-Muster {icon="point"}

**Abfragezeilen durchlaufen**

```html
<table>
  <tbody>
    {% for row in rows %}
      <tr>
        <td>{{ row.Name }}</td>
        <td>{{ row.Status | default: "-" }}</td>
      </tr>
    {% endfor %}
  </tbody>
</table>
```

**Generische Spaltentabelle**

```html
<table>
  <thead>
    <tr>
      {% for column in columns %}
        <th>{{ column.label }}</th>
      {% endfor %}
    </tr>
  </thead>
  <tbody>
    {% for row in rows %}
      <tr>
        {% for column in columns %}
          <td>{{ row[column.key] | default: "-" }}</td>
        {% endfor %}
      </tr>
    {% endfor %}
  </tbody>
</table>
```

**Code-128-Barcode**

```text
{% if rows.size > 0 and columns.size > 0 %}
  {% assign first = rows[0] %}
  {% assign codeColumn = columns[0] %}
  {% assign codeValue = first[codeColumn.key] | default: table.name %}
{% else %}
  {% assign codeValue = table.name %}
{% endif %}
<img alt="Asset barcode" src='{{ codeValue | barcode_data_url: "code128", true }}'>
```

**QR-Code**

```html
<img alt="Record QR code" src='{{ document.number | default: table.name | barcode_data_url: "qrcode" }}'>
```

## Vorschau, Daten, Quelle {icon="layout-list"}

:::reference
- **Vorschau:** Rendert den aktuellen nicht gespeicherten Entwurf als PDF. Nutze **Vorschau öffnen** für eine bildschirmfüllende Prüfung.
- **Daten:** Zeigt die exakten Liquid-Pfade für den ausgewählten Vorschaudatensatz. Kopiere Pfade von hier, statt Objektstrukturen zu erraten.
- **Quelle:** Zeigt das GQL nach dem Ersetzen der Liquid-Variablen. Nutze es zur Fehlersuche bei Filtern für den aktuellen Datensatz.
:::

## Mit generierten Dokumenten arbeiten {icon="file-description"}

Die Dokumentseite listet jedes generierte Dokument einer Vorlage auf. Nutze **Tabelle** für eine durchsuchbare Liste oder **Ordner**, um nach Jahr und Monat zu navigieren. Eine Suche wechselt zum Tabellenergebnis, damit passende Dokumente nicht in Ordnern verborgen bleiben.

Vor der Generierung kannst du Tags ergänzen und bei einer HTML-Vorlage den Dateinamen überschreiben. Ein E-Rechnungsrenderer bestimmt seine Artefaktdateinamen selbst. Nummer, Dateiname, Tags und Artefakte eines abgeschlossenen Dokuments sind unveränderlich.

Leseberechtigung auf die Basis erlaubt das Durchsuchen und erneute Herunterladen generierter Dokumente. Schreibberechtigung erlaubt zusätzlich Generierung. Personen mit Verwaltungsrechten verwalten Vorlagen. Eine lesende Person einer Grids App darf nur ein Dokument für den aktuellen Seitendatensatz herunterladen, dessen Vorlage in der veröffentlichten Capability dieses Datensatzblocks enthalten ist. Dieser App-begrenzte Download gewährt keinen allgemeinen Dokumentzugriff auf die Basis.

Erstelle einen öffentlichen Link für 1, 7, 30 oder 90 Tage, um ein generiertes PDF ohne Cloud-Anmeldung zu teilen. Der Link öffnet eine minimale Seite mit dem Dateinamen des Dokuments, seiner verbleibenden Gültigkeit und einer Schaltfläche zum Herunterladen des PDFs. Er gewährt niemals Zugriff auf andere Dokumente oder Datensätze. Ein optionaler Kommentar erklärt Personen mit Bearbeitungsrechten den Zweck des Links. Die erstellende Person oder eine Person mit Dokumentbearbeitung kann den Link vor Ablauf widerrufen.

## Snapshots und gespeicherte Dokumente {icon="point"}

Beim Generieren eines PDFs entsteht ein rekursiver Snapshot des Wurzeldatensatzes und der über Relationsfelder erreichten verknüpften Datensätze. Ein Snapshot umfasst höchstens vier Relationsebenen und 500 Datensätze. Grids rendert einmal und speichert die exakten abgeschlossenen PDF-Bytes zusammen mit SHA-256, MIME-Typ, Größe, Renderer-Version, Vorlagenrevision, Dokumentnummer und Quell-Snapshot. Downloads geben diese gespeicherten Bytes auch dann zurück, wenn sich aktive Datensätze, Vorlage oder Renderer geändert haben.

Nutze **Erneut generieren**, um ein neues Dokument und seine Artefakte zu erstellen. Ein älteres Dokument wird nie ersetzt. Öffne die Dokumentdetails, um Renderer, Quelldatensatz, Validierungsstatus und Artefakthashes zu prüfen.

:::reference
- **Dokumentnummern:** Jedes Dokument erhält eine stabile Nummer. HTML-Vorlagen verwenden ihr konfiguriertes Nummernmuster; ein E-Rechnungsrenderer bestimmt seine Nummerierung selbst. Vergaben werden nie wiederverwendet; technische Lücken sind möglich. Änderungen am Muster betreffen nur zukünftige Dokumente.
- **Vorlagenänderungen:** Eine Änderung der Vorlage betrifft zukünftige Generierungen. Vorhandene gespeicherte Artefakte werden nie erneut gerendert.
- **Manuelle Snapshots:** Der Detailbereich eines Datensatzes besitzt zusätzlich eine Snapshot-Schaltfläche, um einen Datensatzzustand ohne PDF-Erzeugung zu erfassen.
- **Gelöschte Vorlagen:** Das Löschen einer Vorlage entfernt sie aus der aktiven Liste und archiviert ihren vorlageneigenen Nummernkreis. Die Wiederherstellung einer HTML-Vorlage verbindet diesen Nummernkreis und Höchststand erneut. Vorhandene generierte Dokumente bleiben im unveränderlichen Katalog.
:::

## Praktische Grenzen {icon="point"}

Grids lehnt Vorlagen ab, die diese Grenzen überschreiten, statt eine Abfrage oder ein Dokument unbemerkt zu kürzen:

| Eingabe | Grenze |
| --- | ---: |
| GQL-Quelle | 20.000 Bytes |
| Inhalts-HTML | 200.000 Bytes |
| Kopfzeilen-HTML, Fußzeilen-HTML oder Seiten-CSS | jeweils 50.000 Bytes |
| Nummern- oder Dateinamenmuster | jeweils 5.000 Bytes |
| Gerendertes Inhalts-HTML | 300.000 Bytes |
| GQL-Ergebnis eines Dokuments | 10.000 Zeilen |
| Für Liquid verfügbare Datensatzbilder | 12 Bilder mit jeweils bis zu 2 MB |
| Rekursiver Snapshot | 4 Relationsebenen und 500 Datensätze |

Dies sind Sicherheitsobergrenzen und keine Layoutziele. Teste bei einem Dokument mit Tausenden Zeilen die Seitenumbrüche und Renderdauer mit realistischen Daten, bevor du die Vorlage aktivierst.

## Häufige Probleme {icon="point"}

:::reference
- **Ungültige GQL-Quelle:** Öffne den Tab Quelle. Er zeigt das GQL nach dem Ersetzen der Liquid-Variablen.
- **Fehlende Liquid-Variable:** Wähle einen Vorschaudatensatz, öffne Daten und kopiere dann den exakten Pfad aus dem Baum.
- **Leere Dokumentzeilen:** Prüfe den Filter der GQL-Quelle und ob der ausgewählte Vorschaudatensatz dazu passt.
- **Barcode wird nicht gerendert:** Prüfe Barcode-Typ und Eingabewert. Eine leere Eingabe gibt eine leere Daten-URL zurück.
- **Mehrseitiges Layout bricht:** Verschiebe wiederholte Inhalte in Kopf-/Fußzeile, lege @page-Ränder fest und prüfe die Vorschau mit ausreichend Zeilen.
:::

:::note GQL für Daten, Liquid für Layout verwenden
Lege Filterung, Sortierung, Joins und Gruppierung in GQL ab. Beschränke Liquid auf Schleifen, Bedingungen, Text, Tabellen, Bilder, Barcodes, Kopfzeilen, Fußzeilen und CSS.
:::
