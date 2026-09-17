import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      name: "Legal company name used on billing documents.",
      vat_id: "German VAT ID: DE followed by nine digits. Required before issuing.",
      street: "Street and building number for the billing address.",
      postal_code: "Postal code of the German billing address.",
      city: "City of the German billing address.",
      iban: "Recipient account for incoming payments, refunds or commission settlements.",
      account_name: "Name of the holder of this bank account.",
      reference: "Internal reference for finding this entry; the issued document owns its official number.",
      payment_reference: "Optional bank transaction reference to identify this payment.",
      kind: "Invoice, correction of an invoice, or agreed commission self-billing.",
      party: "Choose the customer or commission supplier. Issuing freezes their billing details.",
      invoice_date: "Date shown on this billing document.",
      service_date: "Date the invoiced service was provided.",
      due_date: "Date by which payment is due.",
      buyer_reference: "Reference agreed with the buyer, for example their order number.",
      positions: "Net prices in EUR.",
      net7: "Sum of rounded line net amounts taxed at 7%.",
      net19: "Sum of rounded line net amounts taxed at 19%.",
      net: "Sum of line net amounts, each rounded to two decimal places.",
      tax: "VAT rounded once per rate group, then added together.",
      gross: "Net amount plus VAT; this amount is frozen when finalized.",
      original: "Issued invoice being corrected. Create this link through Prepare correction.",
      original_company: "Company details from the original issued document. Set by the correction workflow and frozen when issued.",
      original_number: "Official number of the original issued invoice, copied by the correction workflow.",
      original_date: "Document date of the original invoice.",
      agreement: "Shared reference for the agreement allowing the buyer to issue the supplier's settlement.",
      reason: "Explain why the original invoice needs a correction.",
      notes: "Optional internal note. Not included in the PDF or XML.",
      bill: "Original invoice for receipts and refunds, or commission self-billing for a payout. It must be finalized before confirming; the link is then immutable.",
      date: "Date the money actually moved. Recording it does not execute a transfer.",
      amount: "Actual payment amount in EUR, greater than zero.",
      refund: "Set by Record refund. Reduces received payments on the original invoice when confirmed.",
      balance_amount: "Confirmed refunds subtract from received payments; other payments add to them.",
      snapshot: "Linked party detail: live in a draft and frozen with the finalized billing record.",
    },
    de: {
      name: "Rechtlicher Unternehmensname für die Abrechnungsdokumente.",
      vat_id: "Deutsche USt-IdNr.: DE und neun Ziffern. Vor dem Ausstellen erforderlich.",
      street: "Straße und Hausnummer der Rechnungsadresse.",
      postal_code: "Postleitzahl der deutschen Rechnungsadresse.",
      city: "Ort der deutschen Rechnungsadresse.",
      iban: "Empfängerkonto für Zahlungen, Erstattungen oder Provisionsabrechnungen.",
      account_name: "Name des Inhabers dieses Bankkontos.",
      reference: "Interne Suchreferenz; die offizielle Nummer gehört zum ausgestellten Dokument.",
      payment_reference: "Optionale Bankreferenz zur Zuordnung dieser Zahlung.",
      kind: "Rechnung, Rechnungskorrektur oder vereinbarte Provisionsgutschrift.",
      party: "Kunde oder Provisionsempfänger. Die Rechnungsdaten werden beim Ausstellen festgeschrieben.",
      invoice_date: "Datum auf diesem Abrechnungsdokument.",
      service_date: "Datum der abgerechneten Leistung.",
      due_date: "Datum, bis zu dem die Zahlung fällig ist.",
      buyer_reference: "Mit dem Kunden vereinbarte Referenz, etwa seine Bestellnummer.",
      positions: "Nettopreise in EUR.",
      net7: "Summe der gerundeten Nettopositionen mit 7 % Umsatzsteuer.",
      net19: "Summe der gerundeten Nettopositionen mit 19 % Umsatzsteuer.",
      net: "Summe der je Position auf zwei Dezimalstellen gerundeten Nettobeträge.",
      tax: "Je Steuersatz gerundete Umsatzsteuer, anschließend addiert.",
      gross: "Nettobetrag plus Umsatzsteuer; wird beim Festschreiben eingefroren.",
      original: "Ausgestellte Rechnung, die korrigiert wird. Über die Korrekturaktion verknüpfen.",
      original_company:
        "Unternehmensangaben aus dem ursprünglich ausgestellten Dokument. Vom Korrektur-Workflow übernommen und beim Ausstellen festgeschrieben.",
      original_number: "Offizielle Nummer der ursprünglichen Rechnung, vom Korrektur-Workflow übernommen.",
      original_date: "Belegdatum der ursprünglichen Rechnung.",
      agreement: "Gemeinsame Referenz zur Vereinbarung, nach der der Kunde die Abrechnung für den Leistungserbringer ausstellt.",
      reason: "Grund für die Korrektur der ursprünglichen Rechnung.",
      notes: "Optionale interne Notiz. Nicht im PDF oder XML enthalten.",
      bill: "Ursprüngliche Rechnung für Zahlungseingänge und Erstattungen oder Provisionsgutschrift für eine Auszahlung. Vor der Bestätigung muss der Beleg festgeschrieben sein; danach ist die Zuordnung unveränderlich.",
      date: "Datum des tatsächlichen Geldflusses. Die Erfassung führt keine Überweisung aus.",
      amount: "Tatsächlicher Zahlungsbetrag in EUR, größer als null.",
      refund: "Durch Erstattung erfassen gesetzt. Mindert nach Bestätigung die Zahlungseingänge der ursprünglichen Rechnung.",
      balance_amount: "Bestätigte Erstattungen mindern die Zahlungseingänge; andere Zahlungen erhöhen sie.",
      snapshot: "Verknüpfte Partnerangabe: im Entwurf aktuell, im festgeschriebenen Beleg eingefroren.",
    },
  },
});

export const billingFieldHelp = (locale?: string) => {
  const { t } = messages.resolve(locale ? [locale] : []);
  const hints: Record<string, string> = t;
  return (table: string, key: string, type?: string): string => {
    const hintKey = type === "lookup" ? "snapshot" : table === "payments" && key === "reference" ? "payment_reference" : key;
    const hint = hints[hintKey];
    if (!hint) throw new Error(`Missing billing field help: ${table}.${key}`);
    return hint;
  };
};
