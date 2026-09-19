import { i18n } from "@k2b/stdlib";
import { billingApp } from "./billing-app";
import { billingBalanceViews } from "./billing-balances";
import { billingDocumentRenderer, billingDocumentSource } from "./billing-document";
import { billingFieldHelp } from "./billing-field-help";
import { billingAmountFields } from "./billing-lines";
import { billingSamples } from "./billing-samples";
import { billingWorkflows } from "./billing-workflows";
import { field, type GridTemplate, type TemplateField, table } from "./types";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      draftWorkspaceTitle: "Prepare document",
      correctionSummary: "This correction (EUR)",
      correctionSummaryHelp:
        "Reduces the original invoice by this amount. Payments and previous corrections are not included in this preview.",
      invoiceSummary: "Invoice amount (EUR)",
      invoiceSummaryHelp: "Calculated from the current positions. No document is issued when you save the draft.",
      settlementSummary: "Commission amount (EUR)",
      settlementSummaryHelp: "Amount payable to the recipient. Issuing the document does not transfer money.",
      inheritedDetails: "Company and bank details",
      originalContext: "Refers to invoice",
      correctionPositionsHelp: "Keep only the positions and quantities you want to reverse. The original document stays unchanged.",
      correctionDetails: "Reason for correction",
      recipientSection: "Recipient",
      positionsSection: "Services and prices",
      datesSection: "Dates and payment terms",
      additionalSection: "Internal notes",
      companySection: "Company details",
      addressSection: "Billing address",
      bankSection: "Bank account",
      bankHelp: "Needed for refunds and commission payouts.",
      paymentSection: "Payment details",
      savePayment: "Save changes",
      newPartner: "New business partner",
      noPartners: "No business partners yet. Add one here or while creating an invoice.",
      noDrafts: "All drafts completed. Create a new invoice when you are ready.",
      noIssued: "Your issued documents will appear here, with their number and PDF status.",
      noPayments: "No payments recorded yet.",
      noPendingPayments: "No payments waiting for confirmation.",
      pendingPaymentsHelp:
        "Check these entries against your bank transactions. Open an entry to correct it, then confirm it. Only confirmed payments change the outstanding amount.",
      overdueHelp:
        "The due date has passed and an amount is still outstanding. Open a row to record money received for an invoice or a commission paid out for self-billing.",
      upcomingHelp:
        "These amounts are due today or later. Open a row to record an actual payment. Only confirmed payments change the outstanding amount.",
      creditsHelp:
        "A negative outstanding amount means the confirmed payments exceed the document amount after corrections. For an invoice, you may owe the customer a refund; open the invoice to review and record an actual refund. For self-billing, you paid out too much commission: contact the recipient about repayment.",
      overdue: "Overdue",
      upcoming: "Due today or later",
      credits: "Overpayments to review",
      noOverdue: "No overdue payments. You are up to date.",
      noUpcoming: "No payments due today or later.",
      noCredits: "No overpayments to review.",
      reuseInvoice: "Use as new invoice",
      reuseHelp:
        "Check the recipient, buyer reference and prices in this draft. Choose a new service date and due date before issuing the invoice.",
      reuseError: "Choose a finalized invoice to reuse. Credit notes and self-billing cannot be used as a new invoice.",
      refundHelp: "Record a refund that has already occurred. It is included in the balance immediately. This does not transfer money.",
      title: "Billing",
      examplePartner: "Example business partner (replace before issuing)",
      examplePosition: "Example service",
      exampleNotice:
        "Example draft only. Replace the partner and positions and complete your issuer details before issuing. No payment has been recorded.",
      description: "Draft invoices, corrections and agreed commission self-billing with immutable issued documents.",
      positions: "Free-text positions with exact totals",
      documents: "Billing documents",
      parties: "Business partners",
      bills: "Invoices",
      payments: "Payments",
      paid: "Paid",
      corrected: "Corrected",
      outstanding: "Outstanding",
      creditBalance: "Credit",
      settledBalance: "Fully settled.",
      balances: "Open payments",
      paymentTotals: "Payments per bill",
      correctionTotals: "Corrections per invoice",
      customerNumber: "Customer number",
      name: "Name",
      vatId: "VAT ID",
      street: "Street and number",
      postalCode: "Postal code",
      city: "City",
      iban: "IBAN",
      accountName: "Account holder",
      reference: "Reference",
      party: "Business partner",
      kind: "Document kind",
      invoice: "Invoice",
      correction: "Credit note",
      selfBilling: "Self-billing",
      invoiceDate: "Document date",
      serviceDate: "Service date",
      dueDate: "Due date",
      buyerReference: "Buyer reference",
      original: "Original invoice",
      originalCompany: "Original company details",
      reason: "Correction reason",
      agreement: "Self-billing agreement",
      newSelfBilling: "New self-billing draft",
      issueSelfBilling: "Issue self-billing",
      settlementError: "Check the saved draft, business partner and company setup.",
      settlementAgreementError: "Enter the self-billing agreement before issuing this settlement.",
      settlementBankError: "Add the commission recipient's IBAN and account holder under Business partners before issuing this settlement.",
      settlementHelp:
        "Enter the agreed services and amounts directly as positions. Save and review the draft before issuing. Issuing freezes the document; it does not transfer money.",
      note: "Notes",
      amount: "Amount (EUR)",
      date: "Payment date",
      startHelp: "Company and bank details are shared by all documents. A Base admin manages them under Base settings → Documents.",
      draft: "Save draft",
      saved: "Draft saved. Review it before issuing.",
      newInvoice: "New invoice",
      editDraft: "Edit draft",
      savedDetails: "Saved draft details",
      documentDetails: "Document details",
      backToBill: "Back to document",
      paymentForm: "Record payment received",
      payoutForm: "Record payout",
      paymentRecorded: "Payment received recorded.",
      paymentAmountHelp: "Actual amount in EUR, greater than zero.",
      refundRecorded: "Refund recorded.",
      payoutRecorded: "Payout recorded.",
      payoutHelp: "Record a commission payout that has already occurred. This does not transfer money.",
      editPayment: "Edit details",
      refundForm: "Record refund",
      refund: "Customer refund",
      balanceAmount: "Balance effect (EUR)",
      refundError: "Refunds belong to the original invoice and must not exceed its current credit balance. Reload and check the amount.",
      pendingPayments: "Unreviewed payment entries",
      confirmedPayments: "Recorded payments",
      confirmPayment: "Confirm payment",
      confirmPaymentMessage:
        "Confirm that this payment actually occurred? Its amount, date and linked document will become immutable and count toward the balance.",
      paymentPendingHelp:
        "This entry has not been included in the balance yet. Check it against your bank transactions, correct details if needed, then confirm it.",
      paymentConfirmedHelp: "Confirmed payment. Its amount, date and linked document are immutable and included in the balance.",
      paymentError:
        "The payment must still be pending and unchanged, and its linked document must be finalized. Reload and review it before confirming.",
      discardDraft: "Discard draft",
      discardPayment: "Discard pending payment",
      discardPaymentConfirm: "Discard this unconfirmed payment? It has not affected the balance and will be removed.",
      discardDraftConfirm:
        "Move this draft to the trash? It will no longer appear in the draft list. Finalized documents cannot be discarded.",
      paymentHelp:
        "Record a payment that has already been received. It is included in the balance immediately and cannot be edited afterwards. This does not transfer money.",
      partnerHelp:
        "Keep company details current. Issued documents retain their original details. Add the partner's bank account before a refund or self-billing.",
      refundBankError: "Add the recipient's refund IBAN and account holder under Business partners before issuing the credit note.",
      buyer: "Business partner",
      issueInvoiceAction: "Issue invoice",
      issueSelfBillingAction: "Issue self-billing",
      issueCorrectionAction: "Issue credit note",
      issueSelfBillingConfirm: "Issue this self-billing document? This does not transfer money.",
      issueCorrectionConfirm:
        "Issue this credit note and reduce the invoice balance? Issued data is immutable. This does not refund money.",
      issue: "Issue invoice",
      issueConfirm: "Issue this invoice and freeze its data?",
      issueError:
        "Check issuer setup and the selected business partner. If the invoice was just issued, run this action again to retrieve it.",
      creationAccepted: "Document creation requested. You can keep working; its status and PDF will appear here and under Invoices.",
      drafts: "Drafts",
      issued: "Issued documents",
      frozen: "Document details",
      noBills: "No billing documents yet.",
      finalizedHelp:
        "These details can no longer be edited. Open an entry's Documents section for its official number and file; REF identifies only the internal record. Continue creation completes a missing file. Open document opens the finished file with its original number.",
      newCorrection: "Prepare correction",
      issueCorrection: "Issue correction",
      correctionError:
        "Choose a finalized invoice from this issuer. Corrections must not exceed its remaining net or VAT amounts at either tax rate.",
      correctionRoundingError:
        "The positions exceed the remaining net/VAT amount or leave a rounding difference. Adjust the partial positions or correct the full remaining amount so the remainder stays exactly correctable.",
      correctionHelp:
        "For a partial correction, reduce quantities or remove positions. Check the correction reason and choose a due date. The original company and recipient details are retained.",
    },
    de: {
      draftWorkspaceTitle: "Beleg vorbereiten",
      correctionSummary: "Diese Korrektur (EUR)",
      correctionSummaryHelp:
        "Mindert die ursprüngliche Rechnung um diesen Betrag. Zahlungen und frühere Korrekturen sind in dieser Vorschau nicht verrechnet.",
      invoiceSummary: "Rechnungsbetrag (EUR)",
      invoiceSummaryHelp: "Aus den aktuellen Positionen berechnet. Das Speichern des Entwurfs stellt noch keinen Beleg aus.",
      settlementSummary: "Provisionsbetrag (EUR)",
      settlementSummaryHelp: "Betrag für den Empfänger. Das Ausstellen des Belegs überweist kein Geld.",
      inheritedDetails: "Unternehmens- und Bankdaten",
      originalContext: "Bezieht sich auf Rechnung",
      correctionPositionsHelp: "Lass nur die Positionen und Mengen stehen, die du zurücknehmen möchtest. Das Original bleibt unverändert.",
      correctionDetails: "Grund der Korrektur",
      recipientSection: "Empfänger",
      positionsSection: "Leistungen und Preise",
      datesSection: "Datum und Zahlungsziel",
      additionalSection: "Interne Notizen",
      companySection: "Unternehmensangaben",
      addressSection: "Rechnungsadresse",
      bankSection: "Bankverbindung",
      bankHelp: "Für Erstattungen und Provisionsauszahlungen erforderlich.",
      paymentSection: "Zahlungsangaben",
      savePayment: "Änderungen speichern",
      newPartner: "Neuer Geschäftspartner",
      noPartners: "Noch keine Geschäftspartner. Lege hier oder beim Erstellen einer Rechnung einen an.",
      noDrafts: "Alle Entwürfe erledigt. Bei Bedarf kannst du eine neue Rechnung erstellen.",
      noIssued: "Ausgestellte Belege erscheinen hier mit ihrer Nummer und dem PDF-Status.",
      noPayments: "Noch keine Zahlungen erfasst.",
      noPendingPayments: "Keine Zahlungen warten auf Bestätigung.",
      pendingPaymentsHelp:
        "Gleiche diese Einträge mit deinen Bankumsätzen ab. Öffne einen Eintrag zum Korrigieren und bestätige ihn anschließend. Erst bestätigte Zahlungen ändern den offenen Betrag.",
      overdueHelp:
        "Das Zahlungsziel ist überschritten und ein Betrag bleibt offen. Öffne eine Zeile, um bei einer Rechnung einen Zahlungseingang oder bei einer Provisionsgutschrift eine Auszahlung zu erfassen.",
      upcomingHelp:
        "Diese Beträge sind heute oder später fällig. Öffne eine Zeile, um eine tatsächlich erfolgte Zahlung zu erfassen. Erst bestätigte Zahlungen ändern den offenen Betrag.",
      creditsHelp:
        "Ein negativer offener Betrag bedeutet: Die bestätigten Zahlungen übersteigen den Belegbetrag nach Korrekturen. Bei einer Rechnung schuldest du dem Kunden möglicherweise eine Erstattung; öffne die Rechnung zum Prüfen und Erfassen einer tatsächlich erfolgten Erstattung. Bei einer Provisionsgutschrift hast du zu viel Provision ausgezahlt: Kläre die Rückzahlung mit dem Empfänger.",
      overdue: "Überfällig",
      upcoming: "Heute oder später fällig",
      credits: "Überzahlungen prüfen",
      noOverdue: "Keine überfälligen Zahlungen. Alles im Blick.",
      noUpcoming: "Keine heute oder später fälligen Zahlungen.",
      noCredits: "Keine Überzahlungen zu prüfen.",
      reuseInvoice: "Als neue Rechnung übernehmen",
      reuseHelp:
        "Prüfe Empfänger, Kundenreferenz und Preise in diesem Entwurf. Ergänze Leistungsdatum und Fälligkeit, bevor du die Rechnung ausstellst.",
      reuseError:
        "Wähle eine festgeschriebene Rechnung. Korrekturen und Provisionsgutschriften können nicht als neue Rechnung übernommen werden.",
      refundHelp: "Erfasst eine bereits erfolgte Erstattung. Sie wird sofort im Saldo berücksichtigt. Löst keine Überweisung aus.",
      title: "Rechnungswesen",
      examplePartner: "Beispiel-Geschäftspartner (vor Ausstellung ersetzen)",
      examplePosition: "Beispielleistung",
      exampleNotice:
        "Nur ein Beispielentwurf. Ersetze Partner und Positionen und vervollständige deine Ausstellerdaten vor der Ausstellung. Es wurde keine Zahlung erfasst.",
      description: "Rechnungen, Korrekturen und vereinbarte Provisionsgutschriften mit unveränderlichen ausgestellten Dokumenten.",
      positions: "Freitextpositionen mit exakten Summen",
      documents: "Abrechnungsbelege",
      parties: "Geschäftspartner",
      bills: "Rechnungen",
      payments: "Zahlungen",
      paid: "Bezahlt",
      corrected: "Korrigiert",
      outstanding: "Offen",
      creditBalance: "Guthaben",
      settledBalance: "Vollständig ausgeglichen.",
      balances: "Offene Zahlungen",
      paymentTotals: "Zahlungen je Abrechnung",
      correctionTotals: "Korrekturen je Rechnung",
      customerNumber: "Kundennummer",
      name: "Name",
      vatId: "USt-IdNr.",
      street: "Straße und Hausnummer",
      postalCode: "Postleitzahl",
      city: "Ort",
      iban: "IBAN",
      accountName: "Kontoinhaber",
      reference: "Referenz",
      party: "Geschäftspartner",
      kind: "Dokumentart",
      invoice: "Rechnung",
      correction: "Rechnungskorrektur",
      selfBilling: "Provisionsgutschrift",
      invoiceDate: "Belegdatum",
      serviceDate: "Leistungsdatum",
      dueDate: "Fällig am",
      buyerReference: "Kundenreferenz",
      original: "Ursprüngliche Rechnung",
      originalCompany: "Ursprüngliche Unternehmensangaben",
      reason: "Korrekturgrund",
      agreement: "Gutschriftvereinbarung",
      newSelfBilling: "Neue Provisionsgutschrift",
      issueSelfBilling: "Provisionsgutschrift ausstellen",
      settlementError: "Prüfe den gespeicherten Entwurf, den Geschäftspartner und deine Unternehmensangaben.",
      settlementAgreementError: "Trage vor dem Ausstellen die Gutschriftvereinbarung ein.",
      settlementBankError: "Ergänze vor dem Ausstellen IBAN und Kontoinhaber des Provisionsempfängers unter Geschäftspartner.",
      settlementHelp:
        "Erfasse die vereinbarten Leistungen und Beträge direkt als Positionen. Speichere und prüfe den Entwurf vor dem Ausstellen. Das Ausstellen schreibt den Beleg fest; es überweist kein Geld.",
      note: "Notizen",
      amount: "Betrag (EUR)",
      date: "Zahlungsdatum",
      startHelp: "Unternehmens- und Bankdaten gelten für alle Belege. Base-Admins pflegen sie unter Base-Einstellungen → Dokumente.",
      draft: "Entwurf speichern",
      saved: "Entwurf gespeichert. Prüfe ihn vor dem Ausstellen.",
      newInvoice: "Neue Rechnung",
      editDraft: "Entwurf bearbeiten",
      savedDetails: "Gespeicherter Entwurf",
      documentDetails: "Belegdetails",
      backToBill: "Zurück zum Beleg",
      paymentForm: "Zahlungseingang erfassen",
      payoutForm: "Auszahlung erfassen",
      paymentRecorded: "Zahlungseingang erfasst.",
      paymentAmountHelp: "Tatsächlicher Betrag in EUR, größer als null.",
      refundRecorded: "Erstattung erfasst.",
      payoutRecorded: "Auszahlung erfasst.",
      payoutHelp: "Erfasst eine bereits erfolgte Provisionsauszahlung. Löst keine Überweisung aus.",
      editPayment: "Angaben bearbeiten",
      refundForm: "Erstattung erfassen",
      refund: "Kundenerstattung",
      balanceAmount: "Saldowirkung (EUR)",
      refundError:
        "Erstattungen gehören zur ursprünglichen Rechnung und dürfen ihr aktuelles Guthaben nicht überschreiten. Lade neu und prüfe den Betrag.",
      pendingPayments: "Ungeprüfte Zahlungseinträge",
      confirmedPayments: "Erfasste Zahlungen",
      confirmPayment: "Zahlung bestätigen",
      confirmPaymentMessage:
        "Bestätigen, dass diese Zahlung tatsächlich erfolgt ist? Betrag, Datum und zugeordneter Beleg werden unveränderlich und im Saldo berücksichtigt.",
      paymentPendingHelp:
        "Dieser Eintrag ist noch nicht im Saldo berücksichtigt. Gleiche ihn mit deinen Bankumsätzen ab, korrigiere bei Bedarf die Angaben und bestätige ihn anschließend.",
      paymentConfirmedHelp: "Bestätigte Zahlung. Betrag, Datum und zugeordneter Beleg sind unveränderlich und im Saldo berücksichtigt.",
      paymentError:
        "Die Zahlung muss noch unbestätigt und unverändert sein, ihr Beleg bereits festgeschrieben. Lade die Seite neu und prüfe die Angaben vor der Bestätigung.",
      discardDraft: "Entwurf verwerfen",
      discardPayment: "Unbestätigte Zahlung verwerfen",
      discardPaymentConfirm: "Diese unbestätigte Zahlung verwerfen? Sie hat den offenen Betrag noch nicht verändert und wird entfernt.",
      discardDraftConfirm:
        "Diesen Entwurf in den Papierkorb verschieben? Er erscheint danach nicht mehr in der Entwurfsliste. Festgeschriebene Belege können nicht verworfen werden.",
      paymentHelp:
        "Erfasst einen bereits eingegangenen Betrag. Er wird sofort im Saldo berücksichtigt und ist danach unveränderlich. Löst keine Überweisung aus.",
      partnerHelp:
        "Pflege hier die Unternehmensangaben. Ausgestellte Dokumente behalten ihre ursprünglichen Angaben. Ergänze vor Rückzahlungen oder Provisionsgutschriften das Bankkonto des Geschäftspartners.",
      refundBankError:
        "Ergänze unter Geschäftspartner die Erstattungs-IBAN und den Kontoinhaber des Empfängers, bevor du die Korrektur ausstellst.",
      buyer: "Geschäftspartner",
      issueInvoiceAction: "Rechnung ausstellen",
      issueSelfBillingAction: "Provisionsgutschrift ausstellen",
      issueCorrectionAction: "Korrektur ausstellen",
      issueSelfBillingConfirm: "Provisionsgutschrift ausstellen? Ausgestellte Daten sind unveränderlich. Dies überweist kein Geld.",
      issueCorrectionConfirm:
        "Korrektur ausstellen und den Rechnungssaldo mindern? Ausgestellte Daten sind unveränderlich. Dies erstattet kein Geld.",
      issue: "Rechnung ausstellen",
      issueConfirm: "Rechnung ausstellen und ihre Daten festschreiben?",
      issueError:
        "Prüfe Ausstellerangaben und Geschäftspartner. Wurde die Rechnung gerade ausgestellt, führe die Aktion erneut aus, um sie abzurufen.",
      creationAccepted: "Belegerstellung beauftragt. Du kannst weiterarbeiten; Status und PDF erscheinen hier und unter Rechnungen.",
      drafts: "Entwürfe",
      issued: "Ausgestellte Belege",
      frozen: "Rechnungsangaben",
      noBills: "Noch keine Abrechnungen vorhanden.",
      finalizedHelp:
        "Diese Angaben sind nicht mehr bearbeitbar. Öffne den Abschnitt Dokumente eines Eintrags für seine offizielle Nummer und Datei; REF bezeichnet nur den internen Datensatz. Erstellung fortsetzen ergänzt eine fehlende Datei. Dokument öffnen öffnet die fertige Datei mit ihrer ursprünglichen Nummer.",
      newCorrection: "Korrektur vorbereiten",
      issueCorrection: "Korrektur ausstellen",
      correctionError:
        "Wähle eine festgeschriebene Rechnung dieses Ausstellers. Korrekturen dürfen die verbleibenden Netto- und Umsatzsteuerbeträge je Steuersatz nicht überschreiten.",
      correctionRoundingError:
        "Die Positionen überschreiten den verbleibenden Netto-/Steuerbetrag oder hinterlassen eine Rundungsdifferenz. Passe die Teilpositionen an oder korrigiere den gesamten Restbetrag, damit der Rest exakt korrigierbar bleibt.",
      correctionHelp:
        "Für eine Teilkorrektur verringerst du Mengen oder entfernst Positionen. Ergänze Korrekturgrund und Zahlungsziel. Unternehmens- und Empfängerangaben werden aus dem Original übernommen.",
    },
  },
});

export type BillingText = ReturnType<typeof messages.resolve>["t"];

/** Template-owned domain composition; financial rules remain ordinary workflows. */
export function createBillingTemplate(locale?: string): GridTemplate {
  const { t } = messages.resolve(locale ? [locale] : []);
  const fieldHelp = billingFieldHelp(locale);
  const text = (key: string, name: string, required = false, config: Record<string, unknown> = {}): TemplateField => ({
    key,
    name,
    type: "text",
    required,
    config,
  });
  const partyFields = (): TemplateField[] => [
    { ...text("name", t.name, true, { maxLength: 200 }), presentable: true },
    text("vat_id", t.vatId, false, { regex: "^DE[0-9]{9}$" }),
    text("street", t.street, false, { maxLength: 200 }),
    text("postal_code", t.postalCode, false, { maxLength: 20 }),
    text("city", t.city, false, { maxLength: 100 }),
    text("iban", t.iban, false, { maxLength: 34 }),
    text("account_name", t.accountName, false, { maxLength: 200 }),
  ];
  const relation = (key: string, name: string, target: string, required = false, multiple = false): TemplateField => ({
    key,
    name,
    type: "relation",
    required,
    config: { targetTableId: table(target), cardinality: multiple ? "multiple" : "single" },
  });
  const snapshots = (relationKey: string, target: string, prefix: string): TemplateField[] =>
    [{ key: "number", name: t.customerNumber }, ...partyFields()].map((source) => ({
      key: `${relationKey}_${source.key}`,
      name:
        source.key === "number"
          ? t.customerNumber
          : relationKey === "party" && source.key === "name"
            ? t.recipientSection
            : `${prefix}: ${source.name}`,
      type: "lookup",
      hideInTable: true,
      config: { relationFieldId: field(`bills.${relationKey}`), targetFieldId: field(`${target}.${source.key}`) },
    }));
  const amountFields = billingAmountFields("bills", locale);
  const billInputs = ["party", "buyer_reference", "positions", "invoice_date", "service_date", "due_date"];
  const section = (tableKey: string, key: string) => {
    if (tableKey === "bills") {
      if (key === "party") return { title: t.recipientSection };
      if (key === "positions") return { title: t.positionsSection };
      if (key === "invoice_date") return { title: t.datesSection };
      if (key === "notes") return { title: t.additionalSection, collapsible: true };
    }
    if (tableKey === "parties") {
      if (key === "name") return { title: t.companySection };
      if (key === "street") return { title: t.addressSection };
      if (key === "iban") return { title: t.bankSection, description: t.bankHelp, collapsible: true };
    }
    if (tableKey === "payments" && key === "date") return { title: t.paymentSection };
    return undefined;
  };
  const inputs = (tableKey: string, keys: string[], inlineCreate = false, creating = false) =>
    keys.map((key) => ({
      kind: "user_input",
      fieldId: field(`${tableKey}.${key}`),
      ...(["invoice_date", "service_date", "due_date", "date", "amount", "postal_code", "city", "vat_id"].includes(key)
        ? { width: "compact" }
        : {}),
      ...((creating && key === "invoice_date") || (tableKey === "payments" && key === "date" && creating)
        ? { defaultValue: { kind: "now" } }
        : {}),
      ...(["positions", "service_date", "due_date", "reason"].includes(key) ? { required: true } : {}),
      helpText: fieldHelp(tableKey, key),
      ...(section(tableKey, key) ? { section: section(tableKey, key) } : {}),
      ...(inlineCreate && tableKey === "bills" && key === "party"
        ? {
            inlineCreate: {
              enabled: true,
              fields: partyFields()
                .filter((entry) => !["iban", "account_name"].includes(entry.key))
                .map((entry) => ({
                  fieldId: field(`parties.${entry.key}`),
                  helpText: fieldHelp("parties", entry.key),
                  ...(["postal_code", "city", "vat_id"].includes(entry.key) ? { width: "compact" } : {}),
                })),
            },
          }
        : {}),
    }));
  const definition: GridTemplate = {
    id: "billing",
    name: t.title,
    description: t.description,
    highlights: [t.positions, t.documents, t.selfBilling],
    icon: "ti ti-receipt",
    baseName: t.title,
    baseDescription: t.description,
    tables: [
      {
        key: "parties",
        name: t.parties,
        fields: [
          {
            key: "number",
            name: t.customerNumber,
            type: "id",
            presentable: true,
            config: { strategy: "sequence", prefix: "KD-", padding: 5 },
          },
          ...partyFields(),
        ],
      },
      {
        key: "bills",
        name: t.bills,
        finalization: { mode: "direct" },
        mutationPolicy: { mode: "selected", sources: ["form", "workflow"] },
        fields: [
          {
            key: "reference",
            name: t.reference,
            type: "id",
            presentable: true,
            config: { strategy: "short_code", prefix: "REF-", length: 8 },
          },
          {
            key: "kind",
            name: t.kind,
            type: "select",
            required: true,
            config: {
              multiple: false,
              options: [
                { id: "invoice", label: t.invoice },
                { id: "creditNote", label: t.correction },
                { id: "selfBilling", label: t.selfBilling },
              ],
            },
          },
          relation("party", t.party, "parties", true),
          { key: "invoice_date", name: t.invoiceDate, type: "date", required: true, defaultValue: { kind: "now" } },
          // Reused drafts need new dates. Forms and the issuance profile require
          // them; creating an unfinished draft must not invent or copy dates.
          { key: "service_date", name: t.serviceDate, type: "date" },
          { key: "due_date", name: t.dueDate, type: "date" },
          text("buyer_reference", t.buyerReference, true, { maxLength: 100 }),
          ...amountFields,
          relation("original", t.original, "bills"),
          text("reason", t.reason, false, { maxLength: 500 }),
          { key: "original_company", name: t.originalCompany, type: "json", hideInTable: true },
          text("original_number", `${t.original}: ${t.reference}`, false, { maxLength: 100 }),
          { key: "original_date", name: `${t.original}: ${t.invoiceDate}`, type: "date" },
          text("agreement", t.agreement, false, { maxLength: 200 }),
          { key: "notes", name: t.note, type: "longtext" },
          ...snapshots("party", "parties", t.buyer),
        ],
      },
      {
        key: "payments",
        name: t.payments,
        finalization: { mode: "direct" },
        mutationPolicy: { mode: "selected", sources: ["form", "workflow"] },
        fields: [
          relation("bill", t.bills, "bills", true),
          { key: "date", name: t.date, type: "date", required: true },
          { key: "amount", name: t.amount, type: "number", required: true, config: { decimalPlaces: 2, min: "0.01" } },
          { key: "refund", name: t.refund, type: "boolean", required: true, defaultValue: false },
          {
            key: "balance_amount",
            name: t.balanceAmount,
            type: "formula",
            hideInTable: true,
            config: {
              expression: {
                $formula: ["IF(", field("payments.refund"), ", -", field("payments.amount"), ", ", field("payments.amount"), ")"],
              },
              format: { kind: "decimal", precision: 2 },
            },
          },
          { ...text("reference", t.reference), presentable: true },
        ],
      },
    ],
    records: billingSamples(t),
    navigationGroups: [
      {
        name: t.title,
        entries: [
          { type: "customApp", key: "billing" },
          { type: "view", key: "balances" },
          { type: "form", key: "new_invoice" },
          { type: "documentTemplate", key: "billing" },
        ],
      },
      {
        name: t.selfBilling,
        entries: [
          { type: "form", key: "new_self_billing" },
          { type: "workflow", key: "issue_self_billing" },
        ],
      },
      {
        name: t.parties,
        entries: [
          { type: "table", key: "parties" },
          { type: "table", key: "payments" },
        ],
      },
    ],
    views: billingBalanceViews(t),
    documentTemplates: [
      {
        key: "billing",
        table: "bills",
        name: t.documents,
        source: billingDocumentSource(),
        renderer: billingDocumentRenderer,
        issuancePolicy: "oncePerFinalizedRecord",
        enabled: true,
      },
    ],
    forms: [
      {
        key: "new_self_billing",
        table: "bills",
        name: t.newSelfBilling,
        config: {
          fields: [
            ...inputs(
              "bills",
              ["party", "buyer_reference", "agreement", "positions", "invoice_date", "service_date", "due_date"],
              false,
              true,
            ),
            { kind: "form_value", fieldId: field("bills.kind"), value: ["selfBilling"] },
          ],
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
        },
      },
      {
        key: "edit_self_billing",
        table: "bills",
        name: t.selfBilling,
        config: {
          fields: inputs("bills", [
            "party",
            "buyer_reference",
            "agreement",
            "positions",
            "invoice_date",
            "service_date",
            "due_date",
            "notes",
          ]),
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
        },
      },
      {
        key: "partner",
        table: "parties",
        name: t.party,
        config: {
          fields: inputs(
            "parties",
            partyFields().map((entry) => entry.key),
          ),
        },
      },
      {
        key: "new_invoice",
        table: "bills",
        name: t.newInvoice,
        config: {
          fields: [...inputs("bills", billInputs, true, true), { kind: "form_value", fieldId: field("bills.kind"), value: ["invoice"] }],
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
          successMessage: t.saved,
        },
      },
      {
        key: "edit_draft",
        table: "bills",
        name: t.editDraft,
        config: {
          fields: inputs("bills", [...billInputs, "notes"]),
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
        },
      },
      {
        key: "edit_correction",
        table: "bills",
        name: t.correction,
        config: {
          fields: inputs("bills", ["positions", "reason", "invoice_date", "service_date", "due_date", "buyer_reference", "notes"]).map(
            (entry, index) => ({
              ...entry,
              ...(index === 0 ? { section: { title: t.positionsSection, description: t.correctionPositionsHelp } } : {}),
              ...(index === 1 ? { section: { title: t.correctionDetails } } : {}),
            }),
          ),
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
        },
      },
      {
        key: "edit_payment",
        table: "payments",
        name: t.payments,
        config: {
          fields: inputs("payments", ["date", "amount", "reference"]),
          submitLabel: t.savePayment,
          successMessage: t.paymentPendingHelp,
        },
      },
    ],
    workflows: billingWorkflows(t, locale),
    customApps: billingApp(t, amountFields.find((field) => field.key === "gross")!.name),
    workflowLaunchers: [
      ...[
        { key: "record_payment", name: t.paymentForm },
        { key: "record_refund", name: t.refundForm },
        { key: "record_payout", name: t.payoutForm },
      ].map(({ key, name }) => ({
        key,
        workflow: key,
        name,
        config: { kind: "customApp" as const, inputMode: "prompt" as const },
        enabled: true,
      })),
      {
        key: "reuse_invoice",
        workflow: "reuse_invoice",
        name: t.reuseInvoice,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "confirm_payment",
        workflow: "confirm_payment",
        name: t.confirmPayment,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "discard_draft",
        workflow: "discard_draft",
        name: t.discardDraft,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "issue_self_billing",
        workflow: "issue_self_billing",
        name: t.issueSelfBilling,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      { key: "issue_invoice", workflow: "issue_invoice", name: t.issue, config: { kind: "customApp", inputMode: "prompt" }, enabled: true },
      {
        key: "discard_payment",
        workflow: "discard_payment",
        name: t.discardPayment,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "new_correction",
        workflow: "new_correction",
        name: t.newCorrection,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
      {
        key: "issue_correction",
        workflow: "issue_correction",
        name: t.issueCorrection,
        config: { kind: "customApp", inputMode: "prompt" },
        enabled: true,
      },
    ],
  };
  const icons: Record<string, string> = {
    text: "letter-case",
    longtext: "align-left",
    number: "currency-euro",
    boolean: "checkbox",
    date: "calendar",
    select: "list-check",
    relation: "link",
    lookup: "link",
    rollup: "sum",
    formula: "calculator",
    object_list: "list-details",
    id: "hash",
    json: "braces",
  };
  return {
    ...definition,
    tables: definition.tables.map((entry) => ({
      ...entry,
      fields: entry.fields.map((value) => ({
        ...value,
        description: value.description ?? fieldHelp(entry.key, value.key, value.type),
        icon: `ti ti-${icons[value.type]}`,
      })),
    })),
  };
}
