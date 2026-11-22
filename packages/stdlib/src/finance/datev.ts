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

import { DatevBatchSchema, DatevHeaderSchema, type DatevBatch, type DatevHeader } from "./datev-contracts";
import { total, validate, type FinanceResult } from "./common";
import { ok } from "../result";

export type DatevFile = { bytes: Uint8Array; rowCount: number; debitTotal: string; creditTotal: string };

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const compactDate = (value: string) => value.replaceAll("-", "");
const datevDate = (value: string) => `${value.slice(8, 10)}${value.slice(5, 7)}`;

/** DATEV 700/13 EUR serialization. No application identities or side effects. */
function serialize(input: DatevBatch): FinanceResult<DatevFile> {
  const checked = validate(DatevBatchSchema, input);
  if (!checked.ok) return checked;
  const batch = checked.data;
  const timestamp = batch.createdAt.replace(/[-:TZ.]/g, "");
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
    quoted(batch.applicationInformation ?? ""),
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
    // DATEV column 20 explicitly specifies BEDI "<GUID>" and doubled inner quotes:
    // https://developer.datev.de/de/file-formats/details/datev-format/format-description/booking-batch
    // Case is preserved to match document@guid; CSV case-insensitivity is not claimed.
    fields[19] = row.documentGuid === undefined ? "" : quoted(`BEDI "${row.documentGuid}"`);
    fields[36] = row.costCenter1 === undefined ? "" : quoted(row.costCenter1);
    fields[37] = row.costCenter2 === undefined ? "" : quoted(row.costCenter2);
    fields[113] = batch.finalize ? "1" : "0";
    return fields.join(";");
  });
  return ok({
    bytes: new TextEncoder().encode(`\uFEFF${[header.join(";"), columns.join(";"), ...lines].join("\r\n")}\r\n`),
    rowCount: batch.rows.length,
    debitTotal: total(batch.rows.filter(row => row.direction === "S").map(row => row.amount)),
    creditTotal: total(batch.rows.filter(row => row.direction === "H").map(row => row.amount)),
  });
}

export const datev = {
  validateHeader: (input: unknown): FinanceResult<DatevHeader> => validate(DatevHeaderSchema, input),
  validate: (input: unknown): FinanceResult<DatevBatch> => validate(DatevBatchSchema, input),
  serialize,
};
