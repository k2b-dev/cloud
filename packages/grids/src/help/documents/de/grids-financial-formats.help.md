---
id: grids-financial-formats
title: Finanzdateiformate
icon: ti ti-file-invoice
description: Unterstützte E-Rechnungs-, DATEV- und SEPA-Eingaben, Grenzen und sichere Exporte.
order: 136
---
Grids bietet einen definierten Umfang an Finanzformaten. Wähle ein vom Empfänger unterstütztes Format und prüfe eine repräsentative Datei mit dessen Importeinstellungen. Erstellen und Validieren überweist kein Geld, importiert keine Buchhaltung und bestätigt keine Rechtskonformität.

## Formate und Zuständigkeiten

| Grids-Ausgabe | Unterstütztes Format | Ergebnis |
| --- | --- | --- |
| E-Rechnungsrenderer `de.zugferd.en16931`, Versionen 1 und 2 | ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, CII | PDF mit eingebetteter `factur-x.xml` und separater XML-Datei |
| `datev-csv`, Version 1 | DATEV 700/13, EUR | UTF-8-CSV mit BOM; Dateiname `EXTF_*.csv` |
| `sepa-xml`, Version 1 | SCT `pain.001.001.09`, DK GBIC 5, EUR | Eine XML-Datei mit einer oder mehreren Überweisungen |
| Lesendes `parseDocument` | `camt.052.001.08` | Gespeicherte Kontoberichte und Original-XML, keine Zahlungsdatensätze |

Berechnung und Serialisierung verwenden öffentliche APIs aus stdlib 0.25.0. Grids verwaltet Datenstände, Rechte, Workflow-Identitäten, Bestätigung, unveränderliche Ausstellung und Schutz vor Doppelexporten. Freies CSV/JSON/XML und HTML-PDF bleiben eigene allgemeine Ausgaben.

## E-Rechnungseingabe

`cld grids documents renderers --json` zeigt installierte Renderer; deren `inputSchema` beschreibt die Eingabestruktur. Liquid-JSON der Vorlage ordnet den ausgewählten Datensatz zu. Prüfe die Vorschau, bevor du die Vorlage aktivierst.

Beide Versionen benötigen `invoiceDate`, `dueDate`, `currency: "EUR"`, `seller`, `buyer`, `buyerReference`, `payment` und `lines`. Parteien haben `name`, deutsche `vatId` und `address: {line1, city, postalCode, countryCode:"DE"}`. Zahlung enthält `iban` und `accountName`. Daten sind echte ISO-Kalendertage; Fälligkeit nicht vor Rechnungsdatum.

Jede der 1–1.000 Positionen hat `name`, positive `quantity` mit vier Nachkommastellen, nichtnegative `unitPrice` mit vier und positive `taxRate` mit zwei Nachkommastellen, höchstens 100. Übergebe Dezimalstrings, keine Fließkommazahlen. Positionsnetto wird kaufmännisch auf Cent gerundet, Steuer je Steuersatzgruppe. PDF und XML verwenden dieselben Summen.

Version 2 benötigt zusätzlich `serviceDate` und `billing`:

- `{kind:"invoice"}`;
- `{kind:"creditNote", original:{number, invoiceDate}, reason}`;
- `{kind:"selfBilling", agreementReference}`.

Positionen in Version 2 erlauben `description` und `unitCode`: `C62` (Standard), `HUR`, `DAY` oder `KGM`. Mengen und Beträge bleiben positiv; die Belegart trägt die Bedeutung. Bei Selbstabrechnung bleibt der Verkäufer Leistungserbringer und der Käufer Kunde. Das Empfängerkonto muss ausdrücklich angegeben werden.

Diese Grids-Profile sind enger als ein beliebiges Rechnungsmodell: keine steuerfreien Positionen oder Nullsteuer, Zu-/Abschläge, Vorauszahlungen, Eingangsrechnungsimporte oder beliebige XML-Formate. Ob ein Original existiert und Korrektur-/Provisionsbudgets reichen, prüft der Workflow, nicht der Serialisierer. Die Billing-Vorlage ergänzt fachliche Regeln; der Renderer allein fügt sie nicht hinzu.

## SEPA-Überweisungen

Die Workflow-`output` enthält `kind: sepa-xml`, `version: 1`, `header` und `mapping`. Ausführbare Beispiele für Abfrage und Zuordnung stehen unter [Workflows](/app/grids/help/grids-workflows).

Kopf: `destinationKey`, `debtorName` (1–70 Zeichen), `debtorIban`, `executionDate` (ISO-Datum), optional `debtorBic`.

Pflichtzuordnungen: `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, `remittance`; optional `creditorBic`. Zugeordnet werden exakte ausgewählte Spaltenaliase, keine Ausdrücke oder Zellwerte.

- Positiver Betrag mit genau zwei Nachkommastellen, bis `999999999.99`; keine Rundung von Bruchteilen eines Cents.
- Gültige elektronische SEPA-IBAN in Großbuchstaben, ohne Leerzeichen oder QR-IBAN. Ein angegebener BIC muss gültig sein.
- Empfängername bis 70, Verwendungszweck bis 140 Zeichen.
- Namen und Verwendungszweck erlauben A–Z/a–z, Ziffern, Leerzeichen, `+ ? / : ( ) . , ' -` sowie `& * $ % Ä Ö Ü ä ö ü ß`. Andere Zeichen, etwa `é` oder `€`, werden abgelehnt, nicht ersetzt.
- `endToEndId`: nicht leer, höchstens 35 SEPA-Basiszeichen ohne deutsche Erweiterungen, kein führender/abschließender Schrägstrich oder `//`; eindeutig im Stapel.
- Eine Überweisung je eindeutiger `businessId`. Grids erzeugt und behält Nachrichten- und Zahlungsgruppen-IDs.
- Vergangene Ausführungsdaten erzeugen eine Warnung; Grids ersetzt sie nicht durch heute.

Das ist SCT, keine Lastschrift oder Echtzeitüberweisung. Die Bank entscheidet über die Annahme.

## DATEV-Buchungen

Kopf: `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label` und `finalize`.

- Beraternummer: String mit 4–7 Ziffern, mindestens 1001. Mandant: 1–5 Ziffern, erste Ziffer nicht 0.
- Daten zwischen 2000 und 2099. Der geordnete Buchungszeitraum liegt innerhalb eines Wirtschaftsjahres.
- Kontolänge: Ganzzahl 4–8. Bezeichnung: 1–30 Buchstaben/Ziffern, Unterstrich, Punkt, Bindestrich, Schrägstrich oder Leerzeichen.
- `finalize` steuert die Festschreibung beim DATEV-Import, nicht die Finalisierung von Grids-Datensätzen.

Pflichtzuordnungen: `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, `documentNumber`. Optional: `text`, `taxKey`, `costCenter1`, `costCenter2`.

- Positiver Betrag mit zwei Nachkommastellen bis `9999999999.99`; Richtung `S` oder `H`, kein negativer Betrag.
- Konten: Ziffernstrings ungleich null, höchstens 9 Stellen und `accountLength + 1`.
- Belegdatum im Buchungszeitraum. Belegnummer: 1–36 ASCII-Buchstaben/Ziffern oder `_ $ & % * + - /`, keine Leerzeichen.
- Text bis 60 Zeichen ohne Steuerzeichen; Steuerschlüssel genau vier Ziffern.
- Kostenstellen bis 36 Buchstaben/Ziffern, Unterstrich oder Leerzeichen.
- Mehrere Buchungen dürfen zu einem Geschäftsvorfall gehören; jede `entryId` darin muss eindeutig sein.

Dies ist ein Buchungsstapel, nicht die gesamte DATEV-Produktfamilie. ADDISON oder andere Software kann bestimmte Importeinstellungen benötigen.

## Prüfen und Identitäten beibehalten

Beide Workflow-Finanzausgaben erlauben 1–10.000 Zeilen innerhalb des gemeinsamen Speicherlimits für erfasste Daten. `destinationKey`, `businessId` und DATEV-`entryId` haben 1–200 Zeichen ohne umgebende Leer- oder Steuerzeichen. Sie benennen das echte Ziel und den Geschäftsvorfall, nicht Lauf, Dateiname oder neu erzeugten Zufallswert.

Ein manueller Lauf wartet auf Prüfung. Bestätige vor der Ausstellung den exakten Vorschauhash. Zeit- und datensatzgesteuerte Finanzausgaben sind nicht unterstützt. Abbrechen vor der Ausstellung reserviert keinen Exportanspruch; erfolgreiche Ausstellung speichert Dokument und Exportansprüche atomar. Wiederholen verwendet denselben geprüften Vorgang. Ändere Identitäten nie, um den Doppelexportschutz zu umgehen.

Zur Laufzeit werden Eingaben fachlich und erzeugtes E-Rechnungs-/SEPA-XML gegen das festgelegte XSD geprüft. Nach externem PDF-Rendering liest Grids die eingebettete XML und vergleicht sie. XSD- und Einbettungsprüfung sind keine vollständige Schematron- oder PDF/A-Zertifizierung, Steuerberatung oder Bankannahmeprüfung.

Weiter: [Dokumentlebenszyklus](/app/grids/help/grids-documents-pdfs), [CAMT-Eingabe](/app/grids/help/grids-camt), [Billing-Vorlage](/app/grids/help/grids-build-business-app).
