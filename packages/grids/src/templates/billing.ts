import { i18n } from "@k2b/stdlib";
import { billingApp } from "./billing-app";
import { billingBalanceViews } from "./billing-balances";
import { billingDocumentRenderer, billingDocumentSource } from "./billing-document";
import { billingFieldHelp } from "./billing-field-help";
import { billingAmountFields } from "./billing-lines";
import { billingSamples } from "./billing-samples";
import { billingWorkflows } from "./billing-workflows";
import { field, type GridTemplate, record, type TemplateField, table } from "./types";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Billing",
      examplePartner: "Example business partner (replace before issuing)",
      examplePosition: "Example service",
      exampleNotice:
        "Example draft only. Replace the partner and positions and complete your issuer details before issuing. No payment has been recorded.",
      description: "Draft invoices, corrections and agreed commission self-billing with immutable issued documents.",
      positions: "Free-text positions with exact totals",
      documents: "Billing documents",
      parties: "Business partners",
      bills: "Billing documents",
      payments: "Payments",
      paid: "Paid",
      corrected: "Corrected",
      outstanding: "Outstanding",
      balances: "Balances",
      paymentTotals: "Payments per bill",
      correctionTotals: "Corrections per invoice",
      settings: "Billing settings",
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
      ready: "Issuer details checked",
      setup: "Your company",
      setupAction: "Complete issuer details",
      startHelp:
        "Before issuing your first document, enter and check your company and bank details. You can already save drafts. Open a draft to review its positions and totals before issuing.",
      setupHelp:
        "Enter your real issuer and bank details before issuing. This template supports EUR and German businesses with distinct German VAT IDs, at 7% or 19% VAT. It does not provide accounting or legal certification.",
      draft: "Save draft",
      saved: "Draft saved. Review it before issuing.",
      newInvoice: "New invoice",
      editDraft: "Edit draft",
      savedDetails: "Saved draft details",
      documentDetails: "Document details",
      backToBill: "Back to document",
      paymentForm: "Record payment",
      refundForm: "Record refund",
      refund: "Customer refund",
      balanceAmount: "Balance effect (EUR)",
      refundError: "Refunds belong to the original invoice and must not exceed its current credit balance. Reload and check the amount.",
      pendingPayments: "Pending payments",
      confirmedPayments: "Confirmed payments",
      confirmPayment: "Confirm payment",
      confirmPaymentMessage:
        "Confirm that this payment actually occurred? Its amount, date and linked document will become immutable and count toward the balance.",
      paymentPendingHelp:
        "Pending payment: it does not affect balances. Save any changes, then confirm it after checking the money actually received or paid. Its document must already be finalized.",
      paymentConfirmedHelp: "Confirmed payment. Its amount, date and linked document are immutable and included in the balance.",
      paymentError:
        "The payment must still be pending and unchanged, and its linked document must be finalized. Reload and review it before confirming.",
      discardDraft: "Discard draft",
      discardPayment: "Discard pending payment",
      discardDraftConfirm:
        "Move this draft to the trash? It will no longer appear in the draft list. Finalized documents cannot be discarded.",
      paymentHelp:
        "Only confirmed payments affect balances; recording one does not transfer money. Record customer payments and refunds on the original invoice. Record commission payouts on the self-billing document. Always enter a positive amount; the Refund action sets its direction.",
      partnerHelp:
        "Keep company details current. Issued documents retain their original details. Add the partner's bank account before a refund or self-billing.",
      refundBankError: "Add the recipient's refund IBAN and account holder under Business partners before issuing the credit note.",
      seller: "Your company",
      buyer: "Business partner",
      issueInvoiceAction: "Issue / retrieve invoice",
      issueSelfBillingAction: "Issue / retrieve self-billing",
      issueCorrectionAction: "Issue / retrieve credit note",
      issueSelfBillingConfirm:
        "Issue this self-billing document, or retrieve the same document if already issued? This does not transfer money.",
      issueCorrectionConfirm:
        "Issue this credit note and reduce the invoice balance, or retrieve the same document if already issued? Issued data is immutable. This does not refund money.",
      issue: "Issue invoice",
      issueConfirm: "Issue this invoice and freeze its data, or retrieve the same document if already issued?",
      issueError:
        "Check issuer setup and the selected business partner. If the invoice was just issued, run this action again to retrieve it.",
      setupKey: "Setup key",
      drafts: "Drafts",
      issued: "Finalized",
      frozen: "Finalized details",
      noBills: "No billing documents yet.",
      finalizedHelp:
        "These details can no longer be edited. Open an entry's Documents section for its official number and file; REF identifies only the internal record. The Issue / retrieve action completes a missing file or retrieves the same document, never a second one.",
      newCorrection: "Prepare correction",
      issueCorrection: "Issue correction",
      correctionError:
        "Choose a finalized invoice from this issuer. Corrections must not exceed its remaining net or VAT amounts at either tax rate.",
      correctionRoundingError:
        "The positions exceed the remaining net/VAT amount or leave a rounding difference. Adjust the partial positions or correct the full remaining amount so the remainder stays exactly correctable.",
      correctionHelp:
        "Correction drafts initially contain all original positions. Reduce quantities or remove positions for a partial correction. The remaining net and VAT amounts must stay exactly correctable; an incompatible rounding split is rejected before finalization. The document uses the original issuer and recipient details.",
    },
    de: {
      title: "Rechnungswesen",
      examplePartner: "Beispiel-Geschäftspartner (vor Ausstellung ersetzen)",
      examplePosition: "Beispielleistung",
      exampleNotice:
        "Nur ein Beispielentwurf. Ersetze Partner und Positionen und vervollständige deine Ausstellerdaten vor der Ausstellung. Es wurde keine Zahlung erfasst.",
      description: "Rechnungen, Korrekturen und vereinbarte Provisionsgutschriften mit unveränderlichen ausgestellten Dokumenten.",
      positions: "Freitextpositionen mit exakten Summen",
      documents: "Abrechnungsbelege",
      parties: "Geschäftspartner",
      bills: "Abrechnungen",
      payments: "Zahlungen",
      paid: "Bezahlt",
      corrected: "Korrigiert",
      outstanding: "Offen",
      balances: "Salden",
      paymentTotals: "Zahlungen je Abrechnung",
      correctionTotals: "Korrekturen je Rechnung",
      settings: "Abrechnungseinstellungen",
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
      ready: "Ausstellerangaben geprüft",
      setup: "Dein Unternehmen",
      setupAction: "Ausstellerdaten vervollständigen",
      startHelp:
        "Ergänze und prüfe vor dem ersten Ausstellen deine Unternehmens- und Bankdaten. Entwürfe kannst du bereits speichern. Öffne einen Entwurf, um Positionen und Summen vor dem Ausstellen zu prüfen.",
      setupHelp:
        "Trage vor dem Ausstellen deine echten Unternehmens- und Bankdaten ein. Die Vorlage unterstützt EUR und deutsche Unternehmen mit unterschiedlichen deutschen USt-IdNrn., bei 7 % oder 19 % Umsatzsteuer. Sie bietet keine buchhalterische oder rechtliche Zertifizierung.",
      draft: "Entwurf speichern",
      saved: "Entwurf gespeichert. Prüfe ihn vor dem Ausstellen.",
      newInvoice: "Neue Rechnung",
      editDraft: "Entwurf bearbeiten",
      savedDetails: "Gespeicherter Entwurf",
      documentDetails: "Belegdetails",
      backToBill: "Zurück zum Beleg",
      paymentForm: "Zahlung erfassen",
      refundForm: "Erstattung erfassen",
      refund: "Kundenerstattung",
      balanceAmount: "Saldowirkung (EUR)",
      refundError:
        "Erstattungen gehören zur ursprünglichen Rechnung und dürfen ihr aktuelles Guthaben nicht überschreiten. Lade neu und prüfe den Betrag.",
      pendingPayments: "Unbestätigte Zahlungen",
      confirmedPayments: "Bestätigte Zahlungen",
      confirmPayment: "Zahlung bestätigen",
      confirmPaymentMessage:
        "Bestätigen, dass diese Zahlung tatsächlich erfolgt ist? Betrag, Datum und zugeordneter Beleg werden unveränderlich und im Saldo berücksichtigt.",
      paymentPendingHelp:
        "Unbestätigte Zahlung: Sie verändert noch keinen Saldo. Speichere Änderungen und bestätige danach den tatsächlichen Geldeingang oder die Auszahlung. Der zugeordnete Beleg muss bereits festgeschrieben sein.",
      paymentConfirmedHelp: "Bestätigte Zahlung. Betrag, Datum und zugeordneter Beleg sind unveränderlich und im Saldo berücksichtigt.",
      paymentError:
        "Die Zahlung muss noch unbestätigt und unverändert sein, ihr Beleg bereits festgeschrieben. Lade die Seite neu und prüfe die Angaben vor der Bestätigung.",
      discardDraft: "Entwurf verwerfen",
      discardPayment: "Unbestätigte Zahlung verwerfen",
      discardDraftConfirm:
        "Diesen Entwurf in den Papierkorb verschieben? Er erscheint danach nicht mehr in der Entwurfsliste. Festgeschriebene Belege können nicht verworfen werden.",
      paymentHelp:
        "Nur bestätigte Zahlungen verändern den Saldo; die Erfassung überweist kein Geld. Erfasse Kundenzahlungen und Erstattungen an der ursprünglichen Rechnung, Provisionsauszahlungen an der Provisionsgutschrift. Gib den Betrag positiv ein; die Aktion Erstattung bestimmt die Richtung.",
      partnerHelp:
        "Pflege hier die Unternehmensangaben. Ausgestellte Dokumente behalten ihre ursprünglichen Angaben. Ergänze vor Rückzahlungen oder Provisionsgutschriften das Bankkonto des Geschäftspartners.",
      refundBankError:
        "Ergänze unter Geschäftspartner die Erstattungs-IBAN und den Kontoinhaber des Empfängers, bevor du die Korrektur ausstellst.",
      seller: "Dein Unternehmen",
      buyer: "Geschäftspartner",
      issueInvoiceAction: "Rechnung ausstellen / abrufen",
      issueSelfBillingAction: "Provisionsgutschrift ausstellen / abrufen",
      issueCorrectionAction: "Korrektur ausstellen / abrufen",
      issueSelfBillingConfirm:
        "Provisionsgutschrift ausstellen oder den bereits ausgestellten Beleg abrufen? Ausgestellte Daten sind unveränderlich. Dies überweist kein Geld.",
      issueCorrectionConfirm:
        "Korrektur ausstellen und den Rechnungssaldo mindern oder den bereits ausgestellten Beleg abrufen? Ausgestellte Daten sind unveränderlich. Dies erstattet kein Geld.",
      issue: "Rechnung ausstellen",
      issueConfirm: "Rechnung ausstellen und ihre Daten festschreiben oder den bereits ausgestellten Beleg abrufen?",
      issueError:
        "Prüfe Ausstellerangaben und Geschäftspartner. Wurde die Rechnung gerade ausgestellt, führe die Aktion erneut aus, um sie abzurufen.",
      setupKey: "Einrichtungsschlüssel",
      drafts: "Entwürfe",
      issued: "Festgeschrieben",
      frozen: "Festgeschriebene Angaben",
      noBills: "Noch keine Abrechnungen vorhanden.",
      finalizedHelp:
        "Diese Angaben sind nicht mehr bearbeitbar. Öffne den Abschnitt Dokumente eines Eintrags für seine offizielle Nummer und Datei; REF bezeichnet nur den internen Datensatz. Ausstellen / abrufen ergänzt eine fehlende Datei oder ruft denselben Beleg ab, niemals einen zweiten.",
      newCorrection: "Korrektur vorbereiten",
      issueCorrection: "Korrektur ausstellen",
      correctionError:
        "Wähle eine festgeschriebene Rechnung dieses Ausstellers. Korrekturen dürfen die verbleibenden Netto- und Umsatzsteuerbeträge je Steuersatz nicht überschreiten.",
      correctionRoundingError:
        "Die Positionen überschreiten den verbleibenden Netto-/Steuerbetrag oder hinterlassen eine Rundungsdifferenz. Passe die Teilpositionen an oder korrigiere den gesamten Restbetrag, damit der Rest exakt korrigierbar bleibt.",
      correctionHelp:
        "Der Korrekturentwurf enthält zunächst alle ursprünglichen Positionen. Verringere Mengen oder entferne Positionen für eine Teilkorrektur. Verbleibende Netto- und Steuerbeträge müssen exakt korrigierbar bleiben; eine unpassende Rundungsaufteilung wird vor der Festschreibung abgelehnt. Das Dokument verwendet die ursprünglichen Aussteller- und Empfängerangaben.",
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
    partyFields().map((source) => ({
      key: `${relationKey}_${source.key}`,
      name: `${prefix}: ${source.name}`,
      type: "lookup",
      hideInTable: true,
      config: { relationFieldId: field(`bills.${relationKey}`), targetFieldId: field(`${target}.${source.key}`) },
    }));
  const amountFields = billingAmountFields("bills", locale);
  const billInputs = ["party", "invoice_date", "service_date", "due_date", "buyer_reference", "positions"];
  const inputs = (tableKey: string, keys: string[], inlineCreate = false, creating = false) =>
    keys.map((key) => ({
      kind: "user_input",
      fieldId: field(`${tableKey}.${key}`),
      ...(["invoice_date", "service_date", "due_date", "date", "amount", "postal_code", "city", "vat_id"].includes(key)
        ? { width: "compact" }
        : {}),
      ...((creating && key === "invoice_date") || (tableKey === "payments" && key === "date")
        ? { defaultValue: { kind: "now" } } : {}),
      ...(["positions", "due_date"].includes(key) ? { required: true } : {}),
      helpText: fieldHelp(tableKey, key),
      ...(inlineCreate && tableKey === "bills" && key === "party"
        ? {
            inlineCreate: {
              enabled: true,
              fields: partyFields().map((entry) => ({
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
        key: "settings",
        name: t.settings,
        description: t.setupHelp,
        fields: [
          ...partyFields(),
          { key: "ready", name: t.ready, type: "boolean", defaultValue: false },
          { key: "key", name: t.setupKey, type: "text", required: true, uniqueConstraint: true, hideInTable: true, defaultValue: "issuer" },
        ],
      },
      { key: "parties", name: t.parties, fields: partyFields() },
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
          relation("settings", t.settings, "settings", true),
          { key: "invoice_date", name: t.invoiceDate, type: "date", required: true, defaultValue: { kind: "now" } },
          { key: "service_date", name: t.serviceDate, type: "date", required: true },
          // A prepared correction needs a newly chosen deadline. Forms and the
          // issuance profile require it; the initial workflow-created draft may omit it.
          { key: "due_date", name: t.dueDate, type: "date" },
          text("buyer_reference", t.buyerReference, true, { maxLength: 100 }),
          ...amountFields,
          relation("original", t.original, "bills"),
          text("reason", t.reason, false, { maxLength: 500 }),
          text("original_number", `${t.original}: ${t.reference}`, false, { maxLength: 100 }),
          { key: "original_date", name: `${t.original}: ${t.invoiceDate}`, type: "date" },
          text("agreement", t.agreement, false, { maxLength: 200 }),
          { key: "notes", name: t.note, type: "longtext" },
          ...snapshots("settings", "settings", t.seller),
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
    records: [{ key: "settings", table: "settings", required: true, values: { name: t.setup, ready: false } }, ...billingSamples(t)],
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
        name: t.settings,
        entries: [
          { type: "table", key: "settings" },
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
              ["party", "agreement", "invoice_date", "service_date", "due_date", "buyer_reference", "positions"],
              false,
              true,
            ),
            { kind: "form_value", fieldId: field("bills.kind"), value: ["selfBilling"] },
            { kind: "form_value", fieldId: field("bills.settings"), value: [record("settings")] },
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
            "agreement",
            "invoice_date",
            "service_date",
            "due_date",
            "buyer_reference",
            "positions",
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
        key: "setup",
        table: "settings",
        name: t.settings,
        config: { fields: inputs("settings", [...partyFields().map((entry) => entry.key), "ready"]) },
      },
      {
        key: "new_invoice",
        table: "bills",
        name: t.newInvoice,
        config: {
          fields: [
            ...inputs("bills", billInputs, true, true),
            { kind: "form_value", fieldId: field("bills.kind"), value: ["invoice"] },
            { kind: "form_value", fieldId: field("bills.settings"), value: [record("settings")] },
          ],
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
          fields: inputs("bills", ["invoice_date", "service_date", "due_date", "buyer_reference", "positions", "reason", "notes"]),
          computedFields: ["net", "tax", "gross"].map((key) => ({ fieldId: field(`bills.${key}`), width: "compact" })),
          submitLabel: t.draft,
        },
      },
      {
        key: "payment",
        table: "payments",
        name: t.paymentForm,
        config: {
          fields: inputs("payments", ["bill", "date", "amount", "reference"]),
          submitLabel: t.draft,
          successMessage: t.paymentPendingHelp,
        },
      },
      {
        key: "refund",
        table: "payments",
        name: t.refundForm,
        config: {
          fields: [
            ...inputs("payments", ["bill", "date", "amount", "reference"]),
            { kind: "form_value", fieldId: field("payments.refund"), value: true },
          ],
          submitLabel: t.draft,
          successMessage: t.paymentPendingHelp,
        },
      },
    ],
    workflows: billingWorkflows(t, locale),
    customApps: billingApp(t),
    workflowLaunchers: [
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
