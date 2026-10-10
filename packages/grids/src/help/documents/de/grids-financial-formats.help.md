---
id: grids-financial-formats
title: Finanzdateiformate
icon: ti ti-file-invoice
description: Schlage unterstützte E-Rechnungs-, DATEV- und SEPA-Eingaben, ihre Grenzen, Validierung und sichere Exportgrenzen nach.
order: 136
---
Grids unterstützt einen festgelegten Umfang an Finanzformaten. Wähle ein Format, das der Empfänger unterstützt. Prüfe danach eine repräsentative Datei mit den Importeinstellungen des Empfängers.

:::warning Eine gültige Datei ist keine Überweisung
Erstellen oder Validieren einer Datei überweist kein Geld, importiert keine Buchhaltung und bestätigt keine Rechtskonformität.
:::

## Ein Format wählen {icon="file-description"}

| Grids-Ausgabe | Unterstütztes Format | Ergebnis |
| --- | --- | --- |
| E-Rechnungsrenderer `de.zugferd.en16931`, Versionen 1 und 2 | ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, CII | PDF mit eingebetteter `factur-x.xml` und separater XML-Datei |
| `datev-csv`, Version 1 | DATEV 700/13, EUR | UTF-8-CSV mit BOM; Dateiname `EXTF_*.csv` |
| `sepa-xml`, Version 1 | SCT `pain.001.001.09`, DK GBIC 5, EUR | Eine XML-Datei mit einer oder mehreren Überweisungen |

## Eingaben für E-Rechnungen vorbereiten {icon="file-invoice"}

Führe `cld grids documents renderers --json` aus, um den installierten Renderer zu wählen. Sein `inputSchema` ist der Vertrag für die Struktur. Das Liquid-JSON der Vorlage ordnet den ausgewählten Datensatz dieser Eingabe zu. Prüfe die Vorschau, bevor du die Vorlage aktivierst.

:::reference
- **Pflicht in beiden Versionen:** `invoiceDate`, `dueDate`, `currency: "EUR"`, `seller`, `buyer`, `buyerReference`, `payment` und `lines`.
- **Parteien:** `name`, eine deutsche `vatId` und `address: {line1, city, postalCode, countryCode:"DE"}`.
- **Zahlung:** `iban` und `accountName`.
- **Daten:** Echte ISO-Kalendertage. Das Fälligkeitsdatum darf nicht vor dem Rechnungsdatum liegen.
- **Positionen:** 1–1.000 Positionen. Jede hat `name`, eine positive `quantity` mit vier Nachkommastellen, einen nichtnegativen `unitPrice` mit vier Nachkommastellen und eine positive `taxRate` mit zwei Nachkommastellen, höchstens 100.
:::

Übergib Dezimalstrings, keine Fließkommazahlen. Positionsnettobeträge werden kaufmännisch auf Cent gerundet. Die Steuer wird je Steuersatzgruppe gerundet. PDF und XML verwenden dieselben berechneten Summen.

Version 2 braucht zusätzlich `serviceDate` und `billing`:

- `{kind:"invoice"}`;
- `{kind:"creditNote", original:{number, invoiceDate}, reason}`;
- `{kind:"selfBilling", agreementReference}`.

Positionen in Version 2 können `description` und `unitCode` haben: `C62` (Standard), `HUR`, `DAY` oder `KGM`. Mengen und Beträge bleiben positiv. Die Belegart trägt die Bedeutung. Bei Selbstabrechnung bleibt der Verkäufer Leistungserbringer und der Käufer Kunde. Du musst das Empfängerkonto ausdrücklich angeben. Grids leitet es nicht ab.

Diese Grids-Profile sind enger als ein beliebiges Rechnungsmodell. Sie unterstützen keine Nullsteuer oder steuerfreien Positionen, keine Zu- oder Abschläge, keine Vorauszahlungen, keinen Import von Eingangsrechnungen und keine beliebigen XML-Formate. Ob das Original existiert und ob Korrektur- oder Provisionsbudgets reichen, prüfen Workflows. Die Serialisierer prüfen das nicht. Die Billing-Vorlage ergänzt fachliche Regeln. Der Renderer allein fügt sie nicht hinzu.

## Eingaben für SEPA-Überweisungen vorbereiten {icon="transfer"}

Die Workflow-`output` hat `kind: sepa-xml`, `version: 1`, `header` und `mapping`. [Workflows](/app/grids/help/grids-workflows) zeigt ausführbare Beispiele für Abfrage und Zuordnung.

:::reference
- **Kopf:** `destinationKey`, `debtorName` (1–70 Zeichen), `debtorIban`, `executionDate` (ISO-Datum) und optional `debtorBic`.
- **Pflichtzuordnungen:** `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban` und `remittance`.
- **Optionale Zuordnung:** `creditorBic`.
:::

Zuordnungswerte sind exakte ausgewählte Spaltenaliase, keine Ausdrücke oder rohen Zellwerte. Jeder Wert muss diese Regeln erfüllen:

- Der Betrag ist positiv mit genau zwei Nachkommastellen, höchstens `999999999.99`. Grids rundet keine Bruchteile eines Cents.
- Die IBAN ist eine gültige elektronische SEPA-IBAN in Großbuchstaben, ohne Leerzeichen und keine QR-IBAN. Ein angegebener BIC muss gültig sein.
- Der Empfängername hat bis zu 70 Zeichen, der Verwendungszweck bis zu 140.
- Namen und Verwendungszweck erlauben A–Z/a–z, Ziffern, Leerzeichen, `+ ? / : ( ) . , ' -` sowie `& * $ % Ä Ö Ü ä ö ü ß`. Grids lehnt andere Zeichen ab, etwa `é` oder `€`. Grids ersetzt sie nicht.
- `endToEndId` ist nicht leer und hat höchstens 35 SEPA-Basiszeichen ohne die deutschen Erweiterungen. Sie hat keinen führenden oder abschließenden Schrägstrich und kein `//`. Sie ist im Stapel eindeutig.
- Grids erstellt eine Überweisung je eindeutiger `businessId`. Grids erzeugt und behält die IDs für Nachricht und Zahlungsinformation.
- Ein vergangenes Ausführungsdatum erzeugt eine Warnung. Grids ersetzt es nicht durch das heutige Datum.

Diese Ausgabe ist SCT. Sie ist keine Lastschrift und keine Echtzeitüberweisung. Die empfangende Bank entscheidet, ob sie die Datei annimmt.

## Eingaben für DATEV-Buchungen vorbereiten {icon="receipt"}

Der Kopf hat `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label` und `finalize`:

- Die Beraternummer ist ein String mit 4–7 Ziffern, mindestens 1001. Die Mandantennummer ist ein String mit 1–5 Ziffern, deren erste Ziffer nicht 0 ist.
- Daten liegen zwischen 2000 und 2099. Der Buchungszeitraum muss geordnet sein und innerhalb eines Wirtschaftsjahres liegen.
- Die Kontolänge ist eine Ganzzahl von 4 bis 8. Die Bezeichnung hat 1–30 Buchstaben, Ziffern, Unterstriche, Punkte, Bindestriche, Schrägstriche oder Leerzeichen.
- `finalize` steuert die Festschreibung beim DATEV-Import, nicht die Finalisierung von Grids-Datensätzen.

Pflichtzuordnungen sind `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate` und `documentNumber`. Optional sind `text`, `taxKey`, `costCenter1` und `costCenter2`:

- Der Betrag ist positiv mit zwei Nachkommastellen, bis `9999999999.99`. Die Richtung ist `S` oder `H`. Verwende keine negativen Beträge.
- Konten sind Ziffernstrings ungleich null, mit höchstens 9 Stellen und höchstens `accountLength + 1`.
- Das Belegdatum liegt im Buchungszeitraum. Die Belegnummer hat 1–36 ASCII-Buchstaben, Ziffern oder `_ $ & % * + - /` und keine Leerzeichen.
- Der Text hat bis zu 60 Zeichen ohne Steuerzeichen. Der Steuerschlüssel hat genau vier Ziffern.
- Kostenstellen haben bis zu 36 Buchstaben, Ziffern, Unterstriche oder Leerzeichen.
- Mehrere Buchungen können zu einem Geschäftsvorfall gehören. Jede `entryId` darin muss eindeutig sein.

Diese Ausgabe ist ein Buchungsstapel, nicht die gesamte DATEV-Produktfamilie. ADDISON oder andere Software kann bestimmte Importeinstellungen brauchen.

## Einmal prüfen und Identitäten beibehalten {icon="check"}

Beide Finanzausgaben von Workflows nehmen 1–10.000 Zeilen innerhalb des gemeinsamen Budgets für erfasste Daten an. `destinationKey`, `businessId` und die DATEV-`entryId` haben 1–200 Zeichen ohne umgebende Leer- oder Steuerzeichen. Sie benennen das echte Ziel und den Geschäftsvorfall. Sie benennen keinen Lauf, keinen Dateinamen und keinen neu erzeugten Zufallswert.

Ein manueller Lauf wartet auf eine Prüfung. Bestätige vor der Ausstellung den exakten Vorschauhash. Zeitgesteuerte und datensatzgesteuerte Finanzexporte werden nicht unterstützt. Brichst du vor der Ausstellung ab, reserviert Grids nichts für die Prüfung auf Doppelexporte. Eine erfolgreiche Ausstellung speichert das Dokument und seine Exportreservierungen atomar. Eine Wiederholung verwendet denselben geprüften Beleg.

:::danger Die Prüfung auf Doppelexporte nicht umgehen
Ändere nie Identitäten, um die Prüfung auf Doppelexporte zu umgehen.
:::

Zur Laufzeit validiert Grids die Eingaben fachlich und prüft erzeugtes E-Rechnungs- und SEPA-XML gegen ein festgelegtes XSD. Nach dem externen PDF-Rendering liest Grids das eingebettete XML und vergleicht es. XSD- und Einbettungsprüfungen sind keine vollständige Schematron-Prüfung, keine PDF/A-Zertifizierung, keine Steuerberatung und kein Annahmetest der Bank.

Weiter: [Dokumente und PDFs](/app/grids/help/grids-documents-pdfs), [Billing-Vorlage](/app/grids/help/grids-build-business-app).
