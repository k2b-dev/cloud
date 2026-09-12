import Decimal from "decimal.js";
import type { z } from "zod";
import { canonicalDocumentJson } from "../service/document-json";

// DATEV Buchungsstapel 700/13, retrieved 2026-09-11:
// https://developer.datev.de/de/file-format/details/datev-format/getting-started
// Deliberately EUR-only. Unsupported columns stay empty, never inferred.
const columns = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Kurs",
  "Basis-Umsatz",
  "WKZ Basis-Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Belegfeld 2",
  "Skonto",
  "Buchungstext",
  "Postensperre",
  "Diverse Adressnummer",
  "Geschäftspartnerbank",
  "Sachverhalt",
  "Zinssperre",
  "Beleglink",
  ...Array.from({ length: 8 }, (_, i) => [`Beleginfo - Art ${i + 1}`, `Beleginfo - Inhalt ${i + 1}`]).flat(),
  "KOST1 - Kostenstelle",
  "KOST2 - Kostenstelle",
  "Kost-Menge",
  "EU-Land u. UStID (Bestimmung)",
  "EU-Steuersatz (Bestimmung)",
  "Abw. Versteuerungsart",
  "Sachverhalt L+L",
  "Funktionsergänzung L+L",
  "BU 49 Hauptfunktionstyp",
  "BU 49 Hauptfunktionsnummer",
  "BU 49 Funktionsergänzung",
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation- Inhalt ${i + 1}`]).flat(),
  "Stück",
  "Gewicht",
  "Zahlweise",
  "Forderungsart",
  "Veranlagungsjahr",
  "Zugeordnete Fälligkeit",
  "Skontotyp",
  "Auftragsnummer",
  "Buchungstyp",
  "USt-Schlüssel (Anzahlungen)",
  "EU-Land (Anzahlungen)",
  "Sachverhalt L+L (Anzahlungen)",
  "EU-Steuersatz (Anzahlungen)",
  "Erlöskonto (Anzahlungen)",
  "Herkunft-Kz",
  "Buchungs GUID",
  "KOST-Datum",
  "SEPA-Mandatsreferenz",
  "Skontosperre",
  "Gesellschaftername",
  "Beteiligtennummer",
  "Identifikationsnummer",
  "Zeichnernummer",
  "Postensperre bis",
  "Bezeichnung SoBil-Sachverhalt",
  "Kennzeichen SoBil-Buchung",
  "Festschreibung",
  "Leistungsdatum",
  "Datum Zuord. Steuerperiode",
  "Fälligkeit",
  "Generalumkehr (GU)",
  "Steuersatz",
  "Land",
  "Abrechnungsreferenz",
  "BVV-Position",
  "EU-Land u. UStID (Ursprung)",
  "EU-Steuersatz (Ursprung)",
  "Abw. Skontokonto",
];

import { DatevBatchSchema } from "./datev-csv-contracts";

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const compactDate = (value: string) => value.replaceAll("-", "");
const datevDate = (value: string) => `${value.slice(8, 10)}${value.slice(5, 7)}`;

/** Pure serialization; financial authorization, confirmation and reservations belong to issuance. */
export const renderDatevBatch = (input: z.input<typeof DatevBatchSchema>, issuedAt: Date) => {
  const batch = DatevBatchSchema.parse(input);
  canonicalDocumentJson(batch);
  const timestamp = issuedAt.toISOString().replace(/[-:TZ.]/g, "");
  if (!/^20\d{15}$/.test(timestamp)) throw new Error("DATEV creation timestamp must be in 2000–2099.");
  const header = [
    quoted("EXTF"),
    "700",
    "21",
    quoted("Buchungsstapel"),
    "13",
    timestamp,
    "",
    quoted("RE"),
    quoted(""),
    quoted(""),
    batch.consultantNumber,
    batch.clientNumber,
    compactDate(batch.fiscalYearStart),
    String(batch.accountLength),
    compactDate(batch.periodStart),
    compactDate(batch.periodEnd),
    quoted(batch.label),
    quoted(""),
    "1",
    "0",
    batch.finalize ? "1" : "0",
    quoted("EUR"),
    "",
    quoted(""),
    "",
    "",
    quoted(""),
    "",
    "",
    quoted(""),
    quoted("Grids"),
  ];
  const lines = batch.rows.map((row) => {
    const fields: string[] = Array.from({ length: columns.length }, () => "");
    fields[0] = row.amount.replace(".", ",");
    fields[1] = quoted(row.direction);
    fields[2] = quoted("EUR");
    fields[6] = row.account;
    fields[7] = row.counterAccount;
    fields[8] = row.taxKey === undefined ? "" : quoted(row.taxKey);
    fields[9] = datevDate(row.documentDate);
    fields[10] = quoted(row.documentNumber);
    fields[13] = row.text === undefined ? "" : quoted(row.text);
    fields[36] = row.costCenter1 === undefined ? "" : quoted(row.costCenter1);
    fields[37] = row.costCenter2 === undefined ? "" : quoted(row.costCenter2);
    fields[113] = batch.finalize ? "1" : "0";
    return fields.join(";");
  });
  return {
    bytes: new TextEncoder().encode(`\uFEFF${[header.join(";"), columns.join(";"), ...lines].join("\r\n")}\r\n`),
    rowCount: batch.rows.length,
    businessCount: new Set(batch.rows.map((row) => row.businessId)).size,
    debitTotal: batch.rows
      .filter((row) => row.direction === "S")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0))
      .toFixed(2),
    creditTotal: batch.rows
      .filter((row) => row.direction === "H")
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0))
      .toFixed(2),
  };
};
