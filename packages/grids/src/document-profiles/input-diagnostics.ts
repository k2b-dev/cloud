import { i18n } from "@k2b/stdlib";
import type { z } from "zod";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      intro: "Complete or correct these document details",
      retry: "Save the corrected source data, then try again.",
      partyHelp: "Check the service provider and customer details, including the payment recipient's bank details.",
      invoiceHelp: "Check the document details and positions.",
      differentParties: "The service provider and customer must have different VAT IDs",
      originalDate: "The original invoice date must not follow this document's invoice date",
      validDate: "Enter a valid calendar date",
      genericHelp: "Check the source data and the document template's field mapping.",
      seller: "Service provider",
      buyer: "Customer",
      payment: "Payment recipient",
      billing: "Billing details",
      lines: "Line items",
      name: "Name",
      vatId: "VAT ID (DE followed by 9 digits)",
      address: "Address",
      line1: "Street and house number",
      city: "City",
      postalCode: "Postal code",
      countryCode: "Country (DE)",
      iban: "IBAN (valid country code and checksum)",
      accountName: "Account holder",
      invoiceDate: "Invoice date",
      serviceDate: "Service date",
      dueDate: "Due date (not before the invoice date)",
      currency: "Currency (EUR)",
      buyerReference: "Buyer reference",
      quantity: "Quantity (greater than zero)",
      unitPrice: "Net unit price",
      taxRate: "VAT rate",
      unitCode: "Unit",
      description: "Description",
      original: "Original invoice",
      number: "Invoice number",
      reason: "Correction reason",
      kind: "Document kind",
      agreementReference: "Self-billing agreement reference",
      field: "Field",
      document: "Document data",
      more: "Further details also need checking.",
    },
    de: {
      intro: "Ergänze oder korrigiere diese Dokumentangaben",
      retry: "Speichere die korrigierten Quelldaten und versuche es erneut.",
      partyHelp: "Prüfe die Stammdaten von Leistungserbringer und Kunde sowie die Bankverbindung des Zahlungsempfängers.",
      invoiceHelp: "Prüfe die Belegangaben und Positionen.",
      differentParties: "Leistungserbringer und Kunde müssen unterschiedliche USt-IDs haben",
      originalDate: "Das Originalrechnungsdatum darf nicht nach dem Rechnungsdatum dieses Belegs liegen",
      validDate: "Gib ein gültiges Kalenderdatum ein",
      genericHelp: "Prüfe die Quelldaten und die Feldzuordnung der Dokumentvorlage.",
      seller: "Leistungserbringer",
      buyer: "Kunde",
      payment: "Zahlungsempfänger",
      billing: "Abrechnungsangaben",
      lines: "Positionen",
      name: "Name",
      vatId: "USt-ID (DE und 9 Ziffern)",
      address: "Anschrift",
      line1: "Straße und Hausnummer",
      city: "Ort",
      postalCode: "Postleitzahl",
      countryCode: "Land (DE)",
      iban: "IBAN (gültiges Länderkennzeichen und Prüfsumme)",
      accountName: "Kontoinhaber",
      invoiceDate: "Rechnungsdatum",
      serviceDate: "Leistungsdatum",
      dueDate: "Fälligkeitsdatum (nicht vor dem Rechnungsdatum)",
      currency: "Währung (EUR)",
      buyerReference: "Käuferreferenz",
      quantity: "Menge (größer als null)",
      unitPrice: "Netto-Einzelpreis",
      taxRate: "Umsatzsteuersatz",
      unitCode: "Einheit",
      description: "Beschreibung",
      original: "Originalrechnung",
      number: "Rechnungsnummer",
      reason: "Korrekturgrund",
      kind: "Dokumentart",
      agreementReference: "Referenz der Gutschriftvereinbarung",
      field: "Feld",
      document: "Dokumentdaten",
      more: "Weitere Angaben müssen ebenfalls geprüft werden.",
    },
  },
});

/** Schema paths describe fields, never echo payload values or raw validator messages. */
export const documentProfileInputMessage = (profileId: string, issues: readonly z.core.$ZodIssue[], locale?: string): string => {
  const { t } = messages.resolve(locale ? [locale] : []);
  const invoice = profileId === "de.zugferd.en16931";
  const labels: Record<string, string> = {
    seller: t.seller,
    buyer: t.buyer,
    payment: t.payment,
    billing: t.billing,
    lines: t.lines,
    name: t.name,
    vatId: t.vatId,
    address: t.address,
    line1: t.line1,
    city: t.city,
    postalCode: t.postalCode,
    countryCode: t.countryCode,
    iban: t.iban,
    accountName: t.accountName,
    invoiceDate: t.invoiceDate,
    serviceDate: t.serviceDate,
    dueDate: t.dueDate,
    currency: t.currency,
    buyerReference: t.buyerReference,
    quantity: t.quantity,
    unitPrice: t.unitPrice,
    taxRate: t.taxRate,
    unitCode: t.unitCode,
    description: t.description,
    original: t.original,
    number: t.number,
    reason: t.reason,
    kind: t.kind,
    agreementReference: t.agreementReference,
  };
  const details = [
    ...new Set(
      issues.map((issue) => {
        if (!issue.path.length) return t.document;
        if (invoice && issue.code === "custom") {
          if (issue.message === "seller and buyer must be different parties") return t.differentParties;
          if (issue.message === "must not follow invoiceDate") return t.originalDate;
        }
        const dateHint = invoice && issue.code === "custom" && issue.message === "invalid date" ? ` (${t.validDate})` : "";
        return invoice
          ? issue.path
              .map((part) => (typeof part === "number" ? String(part + 1) : (labels[String(part)] ?? `${t.field} ${String(part)}`)))
              .join(" · ") + dateHint
          : `${t.field} ${issue.path.map(String).join(".")}`;
      }),
    ),
  ];
  const partyIssue = issues.some((issue) => ["seller", "buyer", "payment"].includes(String(issue.path[0])));
  const help = invoice ? (partyIssue ? t.partyHelp : t.invoiceHelp) : t.genericHelp;
  return `${t.intro}: ${details.slice(0, 10).join("; ")}. ${details.length > 10 ? `${t.more} ` : ""}${help} ${t.retry}`;
};
