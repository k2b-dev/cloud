import { i18n } from "@k2b/stdlib";
import type { ObjectListConfig } from "../field-types/object-list";
import { field, formula, type TemplateField } from "./types";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      lines: "Positions",
      description: "Description",
      details: "Additional description",
      unit: "Unit",
      pieces: "Pieces",
      hours: "Hours",
      days: "Days",
      kilograms: "Kilograms",
      quantity: "Quantity",
      unitPrice: "Unit price (net)",
      vat: "VAT",
      net: "Net",
      lineNet: "Line amount (net)",
      tax: "VAT amount",
      gross: "Total",
      net7: "Net at 7%",
      net19: "Net at 19%",
      help: "Free-text positions in EUR. This template supports 7% and 19% VAT; check that the selected rate applies to your service.",
    },
    de: {
      lines: "Positionen",
      description: "Beschreibung",
      details: "Ergänzende Beschreibung",
      unit: "Einheit",
      pieces: "Stück",
      hours: "Stunden",
      days: "Tage",
      kilograms: "Kilogramm",
      quantity: "Menge",
      unitPrice: "Einzelpreis (netto)",
      vat: "USt.",
      net: "Netto",
      lineNet: "Positionsbetrag netto",
      tax: "Umsatzsteuer",
      gross: "Gesamt",
      net7: "Netto zu 7 %",
      net19: "Netto zu 19 %",
      help: "Freitextpositionen in EUR. Diese Vorlage unterstützt 7 % und 19 % Umsatzsteuer. Prüfe, ob der gewählte Satz für deine Leistung gilt.",
    },
  },
});

/** Ordinary field configuration: all persisted calculations remain owned by Grids. */
export const billingLineConfig = (locale?: string): ObjectListConfig => {
  const { t } = messages.resolve(locale ? [locale] : []);
  return {
    minItems: 1,
    maxItems: 1_000,
    fields: [
      { id: "Label1", name: t.description, type: "text", required: true, config: { maxLength: 200 } },
      { id: "Detail", detailsOnly: true, name: t.details, type: "longtext", required: false, config: { maxLength: 4_000 } },
      {
        id: "Qty001",
        width: "compact",
        name: t.quantity,
        type: "number",
        required: true,
        defaultValue: "1",
        config: { min: "0.0001", decimalPlaces: 4 },
      },
      {
        id: "Unit01",
        defaultValue: ["C62"],
        width: "compact",
        name: t.unit,
        type: "select",
        required: true,
        config: {
          multiple: false,
          options: [
            { id: "C62", label: t.pieces },
            { id: "HUR", label: t.hours },
            { id: "DAY", label: t.days },
            { id: "KGM", label: t.kilograms },
          ],
        },
      },
      { id: "Price1", width: "compact", name: t.unitPrice, type: "number", required: true, config: { min: "0", decimalPlaces: 4 } },
      {
        id: "Vat001",
        defaultValue: ["vat019"],
        width: "compact",
        name: t.vat,
        type: "select",
        required: true,
        config: {
          multiple: false,
          options: [
            { id: "vat007", label: "7 %" },
            { id: "vat019", label: "19 %" },
          ],
        },
      },
      {
        id: "Net001",
        width: "compact",
        name: t.lineNet,
        type: "number",
        required: false,
        config: { decimalPlaces: 2 },
        formula: { expression: "ROUND(Qty001 * Price1, 2)" },
      },
      // Round each line before accumulating the VAT groups, exactly as the renderer does.
      {
        id: "Net007",
        width: "compact",
        detailsOnly: true,
        name: t.net7,
        type: "number",
        required: false,
        config: { decimalPlaces: 2 },
        formula: { expression: "IF(HAS_OPTION(Vat001, 'vat007'), Net001, 0)" },
      },
      {
        id: "Net019",
        width: "compact",
        detailsOnly: true,
        name: t.net19,
        type: "number",
        required: false,
        config: { decimalPlaces: 2 },
        formula: { expression: "IF(HAS_OPTION(Vat001, 'vat019'), Net001, 0)" },
      },
    ],
  };
};

export const billingAmountFields = (tableKey: string, locale?: string): TemplateField[] => {
  const { t } = messages.resolve(locale ? [locale] : []);
  const positionSum = (column: string) => formula("LIST_SUM(", field(`${tableKey}.positions`), `, '${column}')`);
  const format = { kind: "decimal", precision: 2, thousandsSeparator: true };
  return [
    { key: "positions", name: t.lines, type: "object_list", required: true, description: t.help, config: billingLineConfig(locale) },
    { key: "net7", name: t.net7, type: "formula", hideInTable: true, config: { expression: positionSum("Net007"), format } },
    { key: "net19", name: t.net19, type: "formula", hideInTable: true, config: { expression: positionSum("Net019"), format } },
    { key: "net", name: t.net, type: "formula", config: { expression: positionSum("Net001"), format } },
    {
      key: "tax",
      name: t.tax,
      type: "formula",
      config: {
        expression: formula("ROUND(", field(`${tableKey}.net7`), " * 0.07, 2) + ROUND(", field(`${tableKey}.net19`), " * 0.19, 2)"),
        format,
      },
    },
    {
      key: "gross",
      name: t.gross,
      type: "formula",
      config: {
        expression: formula(field(`${tableKey}.net`), " + ", field(`${tableKey}.tax`)),
        format,
      },
    },
  ];
};
