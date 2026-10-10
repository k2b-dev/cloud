---
id: grids-documents-pdfs
title: Dokumente und PDFs
icon: ti ti-file-type-pdf
description: Erstelle Vorlagen, erzeuge PDF- und Datendateien und prüfe oder teile unveränderliche Dokumente.
order: 135
---
Dokumentvorlagen erzeugen PDFs aus Tabellendatensätzen, etwa Rechnungen, Verträge und Etiketten.

Jede Vorlage gehört zu einer Tabelle und definiert eine Dokumentfamilie. Ein erzeugtes Dokument gehört zu einem ausgewählten Datensatz. Es erhält eine stabile Nummer und einen stabilen Dateinamen und behält den exakten Quell-Snapshot, auch wenn sich die aktiven Datensätze ändern. Es erscheint im Bereich Dokumente des Datensatzes, im Arbeitsbereich seiner Vorlage und im Katalog **Alle Dokumente** der Base.

Nutze Vorlagen für formatierte, teilbare Ausgaben. Nutze CSV- oder JSON-Exporte für den Datenaustausch.

Workflows erzeugen auch ein PDF aus mehreren Datensätzen, freie CSV-, JSON- oder XML-Dateien, DATEV-Buchungsstapel und SEPA-Überweisungsdateien. Alle sind Dokumente, nicht nur PDFs. [Workflows](/app/grids/help/grids-workflows) beschreibt die Konfiguration von Kopf und Zuordnung.

E-Rechnungen erhalten den Status **Nicht geprüft** (`unchecked`). Der Bericht nennt die Prüfungen, die nicht ausgeführt wurden, darunter die Validierung des erzeugten XML und des PDF-Anhangs. Prüfe diesen Bericht, bevor du die Ausgabe verwendest. SEPA-XML wird bei der Erzeugung gegen sein Schema geprüft. Diese Prüfungen zertifizieren nicht den gesamten Geschäftsprozess.

## Das unveränderliche Dokumentmodell verstehen {icon="shield-check"}

Agents finden mit `document.templates` Vorlagen, lesen mit `document.list` und `document.read` gespeicherte Dokumente und stellen mit `document.create` ein Dokument für einen ausgewählten Datensatz aus. Das Ausstellen erfordert Zugriff **Bearbeiten**, einen Idempotenzschlüssel und eine einzelne Genehmigung. Eine Ausstellung lässt sich nicht rückgängig machen, und eine Genehmigung wird nie zu einer Pauschalgenehmigung. Der zurückgegebene Download-Link verlangt deinen vorhandenen Zugriff. Er erstellt keinen öffentlichen Link und versendet das Dokument nicht.

Eine Wiederholung mit demselben Idempotenzschlüssel liefert dasselbe unveränderliche Dokument. Wird der Schlüssel mit anderer Eingabe wiederverwendet, scheitert die Anfrage.

### Einmal je finalisiertem Datensatz ausstellen

`issuancePolicy: "oncePerFinalizedRecord"` lässt sich nur beim Anlegen setzen. Es verwendet über Schlüssel und Läufe hinweg dieselbe eingefrorene Eingabe, Nummer und dasselbe Dokument. Finalisiere zuerst und erzeuge danach. Scheitert das Rendern, wiederhole die Erzeugung für denselben Datensatz und dieselbe Vorlage. Setze die Finalisierung nicht zurück und wiederhole sie nicht. Grids prüft den Zugriff erneut. Eine Live-Vorschau ist nicht nötig und kann abweichen. Standard ist `repeatable`. Kopierte Vorlagen haben getrennte Ausstellungsbereiche.

**Erzeugung wiederholen** sperrt die ursprünglichen Eingaben und die erfassten Daten. Es nutzt keine Live-Vorschau. Bei `repeatable` nutzt **Neuen Versuch starten** die aktuellen Daten für ein weiteres Dokument. Prüfe zuerst **Alle Dokumente**. Eine einmalige Ausstellung verwendet weiterhin das Original. Personen mit Zugriff **Bearbeiten** können mit bestehenden Links weiterarbeiten, auch ohne aktivierte Vorlage.

### Einen Renderer wählen

Eine Vorlage wählt einen Renderer:

- Der HTML-Renderer wandelt Liquid-HTML und CSS in ein PDF um.
- Ein installierter E-Rechnungs-Renderer ordnet den ausgewählten Datensatz über Liquid-JSON zu. Danach erstellt er PDF und strukturiertes Artefakt gemeinsam.

Der Renderer ändert die Artefakte eines Dokuments. Das Dokumentmodell ändert er nicht, ebenso wenig, wie Grids Dokumente erzeugt, auflistet, prüft oder herunterlädt.

Die Validierung belegt nur die technischen Prüfungen, die der gewählte Renderer und seine Version nennen. Sie ist keine allgemeine steuerliche, buchhalterische, Signatur-, Aufbewahrungs- oder Rechtskonformitätsentscheidung. Führe `cld grids documents renderers --json` aus, um die Renderer dieser Installation samt ihrem `inputSchema` zu sehen. `cld grids document-templates reference --json` liefert die Schemas zum Erstellen und Ändern von Vorlagen. Diese Schemas beschreiben die Struktur der Eingabe. Die Vorschau prüft zusätzlich die inhaltlichen Regeln des Renderers.

### Den deutschen E-Rechnungs-Renderer verwenden

`de.zugferd.en16931@1` rendert EUR-Ausgangsrechnungen für deutsche Adressen von Verkäufer und Käufer, Standard-Umsatzsteuer und Überweisung. Es erzeugt PDF/A-3b mit eingebetteter und separater `factur-x.xml`. Es zielt auf ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, mit exakten Dezimalstrings und kaufmännischer Rundung.

Nicht unterstützt sind Korrekturen, Ersatzbelege, Eingangsrechnungen, Steuerbefreiungen, Zu- und Abschläge, Vorauszahlungen, Skonto, Selbstabrechnung und Meldungen. Der Aussteller prüft die Eignung; Grids bestätigt keine Rechtskonformität.

Version 2 (`de.zugferd.en16931@2`) rendert zusätzlich:

- Rechnungskorrekturen mit Nummer und Datum der ursprünglichen Rechnung und einem Grund für die Korrektur;
- Selbstabrechnungen mit einer Vereinbarungsreferenz.

Version 2 verlangt eine ausdrückliche Belegart und ein Leistungsdatum. Mengen und Beträge bleiben positiv. Die Belegart entscheidet, ob es eine Rechnung oder eine Korrektur ist. Bei Selbstabrechnung bleibt der Verkäufer Leistungserbringer und der Käufer der Leistungsempfänger, der den Beleg ausstellt. Die Zahlungsdaten nennen das gewünschte Empfängerkonto. Grids leitet es nicht aus der Belegart ab.

Der Renderer prüft nicht, ob die ursprüngliche Rechnung existiert oder ob noch Beträge für Korrektur oder Provision verfügbar sind. Das muss der ausstellende Workflow sicherstellen, auch bei gleichzeitigen Anfragen. Renderer-Unterstützung allein ist noch keine vollständige Rechnungs-App. Bestehende Vorlagen und Wiederholungen behalten ihre gewählte Version. Eine Vorlage stellst du nur ausdrücklich um.

## Vom Datensatz zum PDF {icon="table"}

Die Vorlage trennt Datenauswahl und Rendering. **GQL** lädt die Zeilen und Spalten, die das Dokument verwenden kann. Der gewählte Renderer erhält danach entweder Liquid-HTML und CSS oder ein Liquid-JSON-Objekt.

**Pipeline**

```text
selected record
  -> fill record values into the GQL source
  -> run the GQL query
  -> render the selected HTML or E-Invoice input
  -> create the artifacts
  -> save the Document and source snapshot
```

Lege Filterung, Sortierung, Joins, Gruppierung und Summen in GQL ab. Beschränke Liquid auf Formulierung und Seitenlayout.

Wähle bei einer E-Rechnungsvorlage den Renderer und ordne die Vorschaudaten unter **Renderer-Eingabe** zu. Der Editor erwartet ein JSON-Objekt. Nutze für jeden eingesetzten Wert den Filter `json`, zum Beispiel `"buyerReference": {{ record.id | json }}`. So bleiben Anführungszeichen und andere Zeichen gültiges JSON. Die Vorschau prüft die Eingabe des Renderers und erzeugt das PDF, bevor du die Vorlage aktivierst. Sie zertifiziert die Ausgabe nicht.

## Die erste Vorlage erstellen {icon="file-description"}

Du brauchst Zugriff **Verwalten** auf die Base, um Vorlagen zu erstellen und zu bearbeiten.

:::steps
1. **Öffne die Vorlagen:** Öffne die Tabelle im **Bearbeitungsmodus** und wähle **Vorlagen**. Vorlagen gehören zu der Tabelle, für die sie Dokumente erzeugen.
2. **Wähle einen Starter:** Nimm die Struktur, die deiner Ausgabe am nächsten kommt. Jeder Starter bleibt vollständig bearbeitbar.
3. **Wähle einen Vorschaudatensatz aus:** Derselbe Datensatz verankert das gerenderte GQL, den Baum unter **Daten** und die PDF-Vorschau.
4. **Prüfe vor dem Bearbeiten:** **Quelle** zeigt das GQL mit eingesetzten Datensatzwerten. **Daten** zeigt die exakten Liquid-Pfade. **Vorschau** zeigt das PDF.
5. **Ändere eine Ebene nach der anderen:** Passe das GQL an, wenn die Daten falsch sind. Passe Inhalt, Kopfzeile, Fußzeile oder Seiten-CSS an, wenn das Layout falsch ist.
6. **Prüfe repräsentative Daten in der Vorschau:** Teste lange Texte, fehlende Werte, viele Zeilen und Seitenumbrüche. Der Editor legt neue Vorlagen deaktiviert an.
7. **Aktiviere und teste:** Danach können Personen mit Zugriff **Bearbeiten** auf die Base einen Datensatz wählen und ein gespeichertes Dokument erzeugen.
:::

Der ausgewählte Vorschaudatensatz ist nur Testkontext. Wenn Personen später ein Dokument erzeugen, wählen sie den tatsächlichen Datensatz. Sie können den Dateinamen überschreiben oder Tags ergänzen.

## Ein Dokument für mehrere Datensätze nutzen {icon="files"}

Ein Workflow kann aus mehreren Datensätzen eine Datei erstellen. Grids speichert die Datei einmal. Sie erscheint im Bereich Dokumente jedes zugeordneten Datensatzes, ob PDF, CSV, JSON, XML, SEPA oder DATEV. Öffne in ihren Details **Quelldatensätze**, um die erfassten Datensatzversionen zu sehen.

Die Quellenliste zeigt die aktuellen lesbaren Namen, sortiert nach stabilen öffentlichen IDs. Eine fehlende erfasste Version bleibt leer und erscheint nicht als Version 0. Nachweispakete behalten nur Quell-IDs und erfasste Versionen, keine aktuellen Namen oder Löschzustände. Ein Paket enthält höchstens 10.000 Quellzuordnungen.

Quelldatensätze und Ergebniszeilen sind unterschiedliche Anzahlen. Ein Join kann einen Datensatz wiederholen, und eine Summe kann viele Datensätze in einer Zeile zusammenfassen. Fehlt die Anzahl der Quelldatensätze, hat Grids keine vollständige Zuordnung erfasst. Das bedeutet nicht null Quelldatensätze. Verknüpfte Adressen, Kunden und andere Relationen werden nicht automatisch zugeordnet.

Eine einfache Zeilenabfrage auf einer gespeicherten Tabelle erfasst ihre Datensatzidentitäten automatisch. Für einen gruppierten oder verknüpften Export kann der Workflow mit `associatedData` eine zuvor erfasste Zeilenabfrage angeben. Grids führt diese Auswahl nach der Erzeugung nicht erneut aus. Die Quellversionen beschreiben den erfassten Stand. Datensatzlinks öffnen den aktuellen Datensatz.

Die Zuordnung zu einem Dokument gibt nie Zugriff auf die ganze Sammeldatei. Personen mit Zugriff auf die Base können diese Dokumente ansehen. Grids Apps zeigen weiterhin nur die Dokumente, die die veröffentlichte App für einen Datensatz ausdrücklich erlaubt. Eine erstellte SEPA-Datei bedeutet nicht, dass ihre Überweisungen bezahlt sind.

## Mit einem Starter beginnen {icon="square-plus"}

Starter sind bearbeitbare Vorlagen, keine festen Dokumenttypen. Wähle die nächstliegende Struktur. Ändere danach die GQL-Quelle und die Liquid-Teile, bis das erzeugte PDF zu den Datensätzen der Tabelle passt.

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

## Die Teile einer Vorlage bearbeiten {icon="table"}

Eine Vorlage hat einen Datenteil und bis zu vier Layoutteile. Grids rendert die GQL-Quelle zuerst mit Liquid. Die Quelle kann deshalb den ausgewählten `record`, die öffentlichen Werte von `app` und die Werte von `business` der Base verwenden, bevor Grids die Abfrage parst.

| Teil | Sprache | Zweck | Häufige Verwendung |
| --- | --- | --- | --- |
| GQL-Quelle | Liquid + GQL | Wählt die für das Dokument verfügbaren Zeilen und Spalten aus. Liquid wird vor dem Parsen von GQL gerendert. | Aktueller Datensatz, verbundene Zeilen, Elementlisten, gruppierte Zusammenfassungen. |
| Inhalt | Liquid + HTML | Hauptinhalt zum Drucken für den HTML-Renderer. | Rechnungsinhalt, Vertragsklauseln, Etikettenlayout, Tabellen mit Datensatzdetails. |
| Kopfzeile | Liquid + HTML | Optionale Kopfzeile auf jeder Seite. | Briefkopf, Absenderidentität, Dokumentklasse, Kontaktblock. |
| Fußzeile | Liquid + HTML | Optionale Fußzeile auf jeder Seite. | Rechtliche Fußzeile, Bankdaten und Seitenplatzhalter wie `<span class="pageNumber"></span>` und `<span class="totalPages"></span>`. |
| Seiten-CSS | Liquid + CSS | Optionales CSS, das in den PDF-Inhalt eingefügt wird. | @page-Größe/-Ränder, Tabellenköpfe, Seitenumbrüche, Drucktypografie. |

PDFs werden offline gerendert. Skripte laufen nicht, und externe Bilder, Stylesheets und Schriften werden nicht geladen. Nutze für Bilder Datensatzbilder, `barcode_data_url` oder andere `data:`-URLs. `app.logoDataUri` druckt das Logo, das in der Cloud-Administration hochgeladen ist. Ein Logo, das als Webadresse gesetzt ist, wird nicht geladen.

## Die verfügbaren Daten verstehen {icon="layout-grid"}

Der Tab **Daten** ist die maßgebliche Quelle für den aktuellen Vorschaudatensatz. Er zeigt die genaue Struktur, die Liquid nach dem Ausführen der GQL-Quelle erhält. Kopiere Pfade aus diesem Baum. Rate keine Objektstrukturen.

Betrachte die Daten in Ebenen. `record` ist der ausgewählte Datensatz. `rows` und `columns` sind das GQL-Ergebnis. `document` beschreibt ein gespeichertes Dokument. `template`, `document` und `date` liefern stabile Metadaten für Nummern und Dateinamen. `app` enthält öffentliche Werte der Plattform für die Darstellung. `business` enthält die gemeinsamen Dokumentangaben der Base. Zeilen stellen zusätzlich die GQL-Ausgabebezeichnungen bereit, deshalb machen lesbare Aliasse Vorlagen leichter wartbar.

:::reference
- **record:** Der aktuelle Datensatz: öffentliche `record.id` und `record.tableId`, `record.version`, `record.data` sowie Erstellungs- und Änderungszeitpunkt.
- **rows und columns:** Die Zeilen und Spalten, die die GQL-Quelle liefert. Nutze `column.key` für den Zugriff auf eine Zeile und `column.label` für lesbare Überschriften.
- **template, document, date:** Stabile Metadaten für Muster und Dokumenttext: `{{ template.name }}`, `{{ template.id }}`, `{{ document.id }}`, `{{ date.iso }}` und `{{ date.yyyyMMdd }}`. Entwurfsvorschauen verwenden Entwurfswerte, bis ein Dokument existiert.
- **app:** Öffentliche Werte der Plattform für die Darstellung von Dokumenten: `{{ app.name }}`, `{{ app.contactEmail }}`, `{{ app.url }}`, `{{ app.logoDataUri }}` und `{{ app.timezone }}`.
- **business:** Dokumentangaben der Base aus **Base-Einstellungen → Dokumente**. `business.legalName` ist der ausdrücklich hinterlegte Name des Ausstellers. Ohne Angabe bleibt er leer und übernimmt nie `app.name`. `business.address` enthält Straße und Adresszusätze so, wie sie eingegeben sind. Nutze `business.postalCode`, `business.city` und `business.countryCode` getrennt. Steuernummer und USt-IdNr. sind getrennte Angaben (`business.taxId`, `business.vatId`). `business.accountName` ist der Kontoinhaber, zusammen mit `business.iban`, `business.bic` und `business.bankName`. Absenderzeile, Zahlungsbedingungen, Fußzeile und Kontaktdaten bleiben verfügbar.
- **images:** Bilddateien, die an Dateifeldern des ausgewählten Datensatzes hängen. Nutze `{{ primaryImage.url }}` für das erste unterstützte Bild oder durchlaufe `images`. Zu große und nicht unterstützte Dateien lässt Grids weg.
- **document:** Dokumentmetadaten wie `{{ document.number }}` und `{{ document.createdAt }}`. Nutze sie in Dateinamen und im HTML von Inhalt, Kopf- oder Fußzeile, nachdem das Nummernmuster gerendert ist. Entwurfsvorschauen können noch keine endgültigen Werte haben.
- **snapshot:** Der erfasste Datensatzgraph eines erzeugten Dokuments. In Live-Entwurfsvorschauen ist er `null`.
- **barcode_data_url:** Ein Grids-Liquid-Filter für Etiketten und Ausweise. Er liefert eine SVG-Daten-URL für QR-Codes und unterstützte BWIP-Barcodesymbole.
:::

## GQL-Quellen schreiben {icon="code"}

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

**Stapel oder Checkliste**

```gql
from table Items
select Name, Status, Location
where Status = 'Ready'
sort Name asc
limit 100
```

## Nummern und Dateinamen festlegen {icon="paperclip"}

Ein erzeugtes Dokument hat eine stabile `document.number`. Eine HTML-Vorlage besitzt einen dauerhaften Nummernkreis. Grids rendert zuerst ihr Nummernmuster. Ihr Dateinamenmuster kann danach `{{ document.number }}` verwenden. Ein E-Rechnungs-Renderer bestimmt seine Nummerierung und seine Artefaktnamen selbst.

Das Standard-Nummernmuster für HTML lautet `{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}`. Ein eigenes Muster kann die vergebene `{{ series.value }}` verwenden. Vergaben steigen atomar und werden nie wiederverwendet, aber Rollbacks und technische Fehler können Lücken hinterlassen. Ein Nummernmuster allein stellt keine Rechtskonformität her.

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
- **Kontext des Nummernmusters:** Kann `record`, `table`, `template`, `document`, `series`, `date`, `app` und `business` verwenden. `series.id` ist die öffentliche ID des Nummernkreises, `series.value` die vergebene Nummer. `document.id` ist bereits verfügbar. `document.number` ist das Ergebnis, das gerade berechnet wird, und deshalb noch nicht verfügbar.
- **Kontext des Dateinamenmusters:** Kann den vollständigen gerenderten Datenbaum verwenden, einschließlich `{{ document.number }}`. Grids bereinigt den endgültigen Dateinamen für sichere PDF-Downloads.
- **Validierung:** Das Speichern einer Vorlage scheitert bei unbekannten Liquid-Variablen auf oberster Ebene, ungültigen Tags, nicht unterstützten Filtern, leeren Mustern und zu großen Mustern.
:::

## Liquid verwenden {icon="book-2"}

Vorlagenteile verwenden Liquid mit Grids-Einschränkungen: strikte Variablen, strikte Filter, maskierte Ausgabe, keine Layouts, keine dynamischen Partials und nur die unten aufgeführten Tags. Unbekannte Filter, ungültige Tags und zu große Ausgaben scheitern und erzeugen nie ein Teildokument.

:::reference
- **Ausgabe:** Gib mit `{{ value }}` einen Wert aus. Die Ausgabe wird standardmäßig für HTML maskiert. Nutze `| raw` nur, wenn eine vertrauenswürdige Vorlage bewusst HTML ausgibt.
- **Filter:** Leite Werte durch Filter, zum Beispiel `{{ row.Name | default: '-' }}`. Unbekannte Filter scheitern.
- **Bedingungen:** Nutze `{% if row.Status == 'Open' %}`, `elsif`, `else` und `endif`.
- **Schleifen:** Nutze `{% for row in rows %}` und `{% endfor %}`. `break` und `continue` sind erlaubt.
- **Temporäre Werte:** Nutze `assign` für kurze Werte und `capture` für längere gerenderte Fragmente.
- **Keine externen Partials:** `include`, `render`, `layout` und Tags für externe Partials sind nicht erlaubt. Eine Vorlage muss in sich geschlossen sein.
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

## Barcodes und QR-Codes einfügen {icon="code"}

Nutze den Filter `barcode_data_url` in einem `<img>`-Tag. Barcode-IDs sind kleingeschriebene Symbole. Das optionale dritte Argument steuert den lesbaren Text bei Barcodeformaten, die ihn unterstützen.

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

| Typ-ID | Bezeichnung | Verwendung |
| --- | --- | --- |
| `code128` | Code 128 | Allgemeiner linearer Barcode. |
| `qrcode` | QR Code | Kompakter 2D-Code für Mobilgeräte. |
| `datamatrix` | Data Matrix | Kleiner 2D-Code für Etiketten. |
| `pdf417` | PDF417 | Gestapelter 2D-Code für Dokumente. |
| `azteccode` | Aztec Code | Dichter 2D-Code ohne Ruhezone. |
| `ean13` | EAN-13 | Produktcode für den Einzelhandel, 13 Ziffern. |
| `ean8` | EAN-8 | Kurzer Produktcode für den Einzelhandel. |
| `upca` | UPC-A | US-Produktcode für den Einzelhandel. |
| `upce` | UPC-E | Komprimierter UPC-Code. |
| `itf14` | ITF-14 | Code für Kartons und Verpackungen. |
| `gs1datamatrix` | GS1 Data Matrix | GS1-2D-Code mit GS1-Kennungen wie `(01)`. |
| `sscc18` | SSCC-18 | Code für Versandbehälter. |
| `isbn` | ISBN | Barcode für Buchkennungen. |
| `issn` | ISSN | Barcode für fortlaufende Publikationen. |
| `ismn` | ISMN | Barcode für gedruckte Musik. |
| `code39` | Code 39 | Einfacher alphanumerischer Barcode. |
| `code93` | Code 93 | Kompakter alphanumerischer Barcode. |
| `interleaved2of5` | Interleaved 2 of 5 | Numerischer Lagerbarcode. |
| `micropdf417` | MicroPDF417 | Kompakter gestapelter 2D-Code. |
| `microqrcode` | Micro QR Code | Kleine QR-Variante. |
| `maxicode` | MaxiCode | 2D-Code für Pakete und Logistik. |
| `dotcode` | DotCode | Punktbasierter Produktionscode. |

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

## Liquid-Muster wiederverwenden {icon="point"}

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

## Vorschau, Daten und Quelle prüfen {icon="layout-list"}

:::reference
- **Vorschau:** Rendert den aktuellen ungespeicherten Entwurf als PDF. Nutze **Vorschau öffnen** für eine bildschirmfüllende Prüfung.
- **Daten:** Zeigt die exakten Liquid-Pfade für den ausgewählten Vorschaudatensatz. Kopiere Pfade von hier. Rate keine Objektstrukturen.
- **Quelle:** Zeigt das GQL, nachdem Grids die Liquid-Variablen ersetzt hat. Nutze es, um Filter für den aktuellen Datensatz zu prüfen.
:::

## Mit erzeugten Dokumenten arbeiten {icon="file-description"}

Die Dokumentseite einer Vorlage listet jedes Dokument, das die Vorlage erzeugt hat. Nutze **Tabelle** für eine durchsuchbare Liste oder **Ordner**, um nach Jahr und Monat zu blättern. Eine Suche wechselt zum Tabellenergebnis, damit Ordner keine passenden Dokumente verbergen.

**Alle Dokumente** listet jedes Dokument der Base in jedem Dateiformat, egal ob eine Vorlage, ein Workflow oder beide es erzeugt haben. Die Seite öffnet sich in **Ordner**, gruppiert nach Dokumentvorlage oder Workflow und danach nach Jahr. Ihre Suche umfasst Dateinamen, Dokumentnummern und Tags der ganzen Base, unabhängig vom geöffneten Ordner. Beide Dokumentseiten zeigen ihre ersten Ergebnisse schon beim Laden der Seite.

### Alle Dokumente filtern und sortieren

Filtere **Alle Dokumente** nach **Workflow**, **Vorlage**, **Datensatztabelle** und **Dateityp**. Kombiniere die Filter, um die Liste einzugrenzen.

- **Datensatztabelle** findet nur Dokumente, die für einen Datensatz dieser Tabelle erzeugt wurden. Quellzeilen eines Workflow-Exports und Dateien in einem ZIP findet sie nicht.
- **Sortierung** wechselt zwischen neueste zuerst (Standard), älteste zuerst und Dateiname.

Eine Suche, ein Filter oder eine andere Sortierung zeigt eine Liste statt Ordnern. Die Adresse behält alles davon, sodass ein Neuladen oder ein geteilter Link dieselbe Ansicht öffnet.

Ein Dokument aus einem Workflow nennt seinen Workflow. Wähle den Namen, um den Lauf zu öffnen, der es erzeugt hat. Die Details eines ZIP-Dokuments listen seinen **Archivinhalt**: jede verpackte Datei, ihre Größe und das Dokument, aus dem sie stammt. Grids verknüpft das Archiv nicht mit den Datensätzen dieser Dokumente.

### Dokumentdetails prüfen

Dokumentdetails bieten die gespeicherten Downloads, die erfasste Zeilenanzahl und den Zeitstempel.

- **Vorschau** zeigt CSV, JSON und XML bis 2 MiB. Größere Dateien bleiben herunterladbar. CSV bleibt Originaltext.
- **Kopieren** kopiert die Datei.
- **Freigabelinks** erstellt öffentliche Links für die gespeicherte Hauptdatei.
- **Technische Details** zeigt IDs und Prüfsummen.
- **Weitere Aktionen → Erneut erzeugen** folgt der Ausstellungsregel der Vorlage und überschreibt nie das Original.

Unterdialoge führen zu den Details zurück.

Vor der Erzeugung kannst du Tags ergänzen. Bei einer HTML-Vorlage kannst du auch den Dateinamen überschreiben. Ein E-Rechnungs-Renderer bestimmt seine Artefaktdateinamen selbst. Nummer, Dateiname, Tags und Artefakte eines abgeschlossenen Dokuments sind unveränderlich.

Der Hauptdownload behält das gespeicherte Dateiformat. Freigabelinks liefern dieselbe Hauptdatei, ob PDF, CSV, JSON oder XML. Sie liefern sie immer als Download, nie als Seite im Browser. In der Eingabe eines Profil-Renderers ist `document.filename` `null`, weil der Renderer seine Dateien noch nicht erzeugt hat. Lies den Dateinamen nach der Erzeugung am abgeschlossenen Dokument ab.

### Den Zugriff auf Dokumente steuern

- Zugriff **Ansehen** auf die Base erlaubt das Durchsuchen und erneute Herunterladen erzeugter Dokumente.
- Zugriff **Bearbeiten** erlaubt zusätzlich die Erzeugung.
- Zugriff **Verwalten** ist nötig, um Vorlagen zu erstellen und zu ändern.

Eine Person, die eine Grids App verwendet, kann nur ein Dokument für den aktuellen Seitendatensatz herunterladen. Seine Vorlage muss in der veröffentlichten Capability dieses Datensatzblocks stehen. Dieser auf die App begrenzte Download gibt keinen allgemeinen Zugriff auf die Dokumente der Base.

### Ein Dokument mit einem öffentlichen Link teilen

Um ein erzeugtes Dokument ohne Cloud-Anmeldung zu teilen, erstelle einen öffentlichen Link für 1, 7, 30 oder 90 Tage. Der Link öffnet eine minimale Seite mit dem Dateinamen des Dokuments und seiner verbleibenden Gültigkeit. Eine Schaltfläche lädt die gespeicherte Hauptdatei im Originalformat herunter. Der Link gibt nie Zugriff auf andere Dokumente oder Datensätze. Ein optionaler Kommentar erklärt Personen, die Dokumente bearbeiten, den Zweck des Links. Die erstellende Person oder eine Person, die Dokumente bearbeiten kann, kann den Link vor Ablauf widerrufen.

## Sich auf Snapshots und gespeicherte Dokumente verlassen {icon="point"}

Beim Erzeugen eines PDFs entsteht ein rekursiver Snapshot des Wurzeldatensatzes und der verknüpften Datensätze, die Relationsfelder erreichen. Ein Snapshot umfasst höchstens vier Relationsebenen und 500 Datensätze. Grids rendert einmal und speichert die exakten fertigen PDF-Bytes mit SHA-256, MIME-Typ, Größe, Renderer-Version, Vorlagenrevision, Dokumentnummer und Quell-Snapshot. Downloads liefern diese gespeicherten Bytes, auch wenn sich aktive Datensätze, Vorlage oder Renderer ändern.

**Erneut erzeugen** hängt von der Ausstellungsregel ab. `repeatable` erstellt ein weiteres Dokument. `oncePerFinalizedRecord` liefert das Original, auch nach Änderungen an der Vorlage. Die Details zeigen Renderer, Quelle, Validierung und Hashes.

:::reference
- **Dokumentnummern:** Jedes Dokument erhält eine stabile Nummer. HTML-Vorlagen verwenden ihr konfiguriertes Nummernmuster. Ein E-Rechnungs-Renderer bestimmt seine Nummerierung selbst. Vergaben werden nie wiederverwendet, technische Lücken sind aber möglich. Änderungen am Muster betreffen nur künftige Dokumente.
- **Vorlagenänderungen:** Eine geänderte Vorlage betrifft künftige Erzeugungen. Vorhandene gespeicherte Artefakte werden nie erneut gerendert.
- **Manuelle Snapshots:** Die Detailansicht eines Datensatzes hat zusätzlich die Schaltfläche **Snapshot**. Sie erfasst einen Datensatzzustand, ohne ein PDF zu erzeugen.
- **Gelöschte Vorlagen:** Das Löschen einer Vorlage entfernt sie aus der aktiven Liste und archiviert ihren Nummernkreis. Die Wiederherstellung einer HTML-Vorlage verbindet diesen Nummernkreis und seinen Höchststand wieder. Vorhandene erzeugte Dokumente bleiben im unveränderlichen Katalog.
:::

## Die praktischen Grenzen kennen {icon="point"}

Grids lehnt Vorlagen ab, die diese Grenzen überschreiten. Es kürzt nie unbemerkt eine Abfrage oder ein Dokument:

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

Das sind Sicherheitsobergrenzen, keine Layoutziele. Teste bei einem Dokument mit Tausenden Zeilen Seitenumbrüche und Renderdauer mit realistischen Daten, bevor du die Vorlage aktivierst.

## Häufige Probleme beheben {icon="point"}

:::reference
- **Ungültige GQL-Quelle:** Öffne den Tab **Quelle**. Er zeigt das GQL, nachdem Grids die Liquid-Variablen ersetzt hat.
- **Fehlende Liquid-Variable:** Wähle einen Vorschaudatensatz, öffne **Daten** und kopiere den exakten Pfad aus dem Baum.
- **Leere Dokumentzeilen:** Prüfe den Filter der GQL-Quelle und ob der ausgewählte Vorschaudatensatz dazu passt.
- **Ungültige E-Rechnungsangaben:** Die Meldung nennt die betroffenen Partei-, Bank- oder Belegfelder. Korrigiere und speichere ihre Quelldatensätze und versuche es erneut. Stimmen die Werte schon, prüfe die Zuordnung unter **Renderer-Eingabe** der Vorlage. Eine Vorschau vergibt keine offizielle Nummer.
- **Barcode wird nicht gerendert:** Prüfe Barcode-Typ und Eingabewert. Eine leere Eingabe liefert eine leere Daten-URL.
- **Mehrseitiges Layout bricht:** Verschiebe wiederholte Inhalte in Kopf- oder Fußzeile, setze @page-Ränder und prüfe die Vorschau mit genug Zeilen.
:::

:::note GQL für Daten, Liquid für Layout verwenden
Lege Filterung, Sortierung, Joins und Gruppierung in GQL ab. Beschränke Liquid auf Schleifen, Bedingungen, Text, Tabellen, Bilder, Barcodes, Kopfzeilen, Fußzeilen und CSS.
:::

## Gespeicherte Dateien als Agent lesen {icon="file-description"}

Agents lesen mit `document.content.read` gespeicherte PDF-, XML- oder CSV-Dateien. Wähle einen Artefakt-Schlüssel aus `document.read` oder lass ihn für die Hauptdatei weg. Code Mode liest den gelieferten Stream als File, mit höchstens 50 MiB pro Datei. Ein Download extrahiert keinen PDF-Text und stellt kein Dokument aus und versendet keines. Beim Download prüft Grids erneut, ob du das Dokument noch lesen kannst.

## Einen Ordner herunterladen {icon="download"}

Wähle in der Ordneransicht **Ordner als ZIP herunterladen** neben einer Vorlage, einem Jahr oder einem Monat. Das Archiv enthält die gespeicherte Hauptdatei jedes Dokuments, einschließlich der Unterordner. Während Grids die Dateien sammelt, kannst du abbrechen.

- Die Grenze liegt bei 1.000 Dokumenten und 100 MiB. Lade größere Sammlungen in kleineren Unterordnern herunter.
- Bei einem Fehler speichert Grids kein unvollständiges Archiv.
- Zusätzliche Artefakte bleiben einzelne Downloads.

Das liest den aktuellen Inhalt des Ordners. Es ist keine eingefrorene Sicherung.
