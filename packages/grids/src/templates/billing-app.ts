import type { BillingText } from "./billing";
import { billingBalanceSource } from "./billing-balances";
import { documentTemplate, field, form, formula, type GridTemplate, launcher, table } from "./types";

/** A document keeps one workspace from editable draft to issued document. */
export const billingApp = (t: BillingText, totalLabel: string): NonNullable<GridTemplate["customApps"]> => {
  const billParams = { bill_id: { type: "record" as const, tableId: table("bills"), required: true as const } };
  const billRecord = { tableId: table("bills"), id: { source: "PARAMS" as const, path: "bill_id" } };
  const billNavigation = { kind: "navigate" as const, pageId: "bill", params: { bill_id: { source: "PARAMS" as const, path: "bill_id" } } };
  const resultNavigation = {
    kind: "navigate" as const,
    pageId: "bill",
    params: { bill_id: { source: "RESULT" as const, path: "recordId" as const } },
  };
  const billWhen = (state?: "draft" | "finalized", kind?: string) => ({
    query: formula(
      "from table ",
      table("bills"),
      "\nselect ",
      field("bills.reference"),
      "\nwhere record.id = @params.bill_id",
      state ? ` and record.finalizationState = '${state}'` : "",
      ...(kind ? [" and ", field("bills.kind"), ` = '${kind}'`] : []),
      "\nlimit 1",
    ),
  });
  const billPaymentWhen = {
    query: formula(
      "from table ",
      table("bills"),
      "\nselect ",
      field("bills.reference"),
      "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized' and ",
      field("bills.kind"),
      " != 'creditNote'\nlimit 1",
    ),
  };
  const openBalance = billingBalanceSource(t, true, { metrics: "outstanding", group: "open" });
  const creditBalance = billingBalanceSource(t, true, { metrics: "credit", group: "credits" });
  const paymentWhen = (state: "draft" | "finalized") => ({
    query: formula(
      "from table ",
      table("payments"),
      "\nselect ",
      field("payments.amount"),
      `\nwhere record.id = @params.payment_id and record.finalizationState = '${state}'\nlimit 1`,
    ),
  });
  const paymentActions = <Source extends "ROW" | "RECORD">(source: Source) => [
    {
      id: "confirm",
      kind: "workflow" as const,
      label: t.confirmPayment,
      icon: "check",
      variant: "primary" as const,
      launcherId: launcher("confirm_payment"),
      inputs: { payment: { source, path: "id" as const } },
      confirm: t.confirmPaymentMessage,
    },
    {
      id: "discard",
      kind: "workflow" as const,
      label: t.discardPayment,
      icon: "trash",
      variant: "danger" as const,
      launcherId: launcher("discard_payment"),
      inputs: { payment: { source, path: "id" as const } },
      confirm: t.discardPaymentConfirm,
    },
  ];
  const paymentEntryActions = (variant: "primary" | "secondary") => [
    {
      id: "receive",
      kind: "workflow" as const,
      label: t.paymentForm,
      icon: "plus",
      variant,
      launcherId: launcher("record_payment"),
      inputs: { bill: { source: "RECORD" as const, path: "id" as const } },
      prompt: { inputs: ["date", "amount", "reference"], description: t.paymentHelp, successMessage: t.paymentRecorded },
      availableWhen: billWhen("finalized", "invoice"),
    },
    {
      id: "payout",
      kind: "workflow" as const,
      label: t.payoutForm,
      icon: "arrow-up-right",
      variant,
      launcherId: launcher("record_payout"),
      inputs: { bill: { source: "RECORD" as const, path: "id" as const } },
      prompt: { inputs: ["date", "amount", "reference"], description: t.payoutHelp, successMessage: t.payoutRecorded },
      availableWhen: billWhen("finalized", "selfBilling"),
    },
  ];
  const payments = (confirmed: boolean, oneBill: boolean) => ({
    id: confirmed ? "payments" : "pending-payments",
    type: "records" as const,
    title: confirmed ? t.confirmedPayments : t.pendingPayments,
    emptyText: confirmed ? t.noPayments : t.noPendingPayments,
    source: {
      kind: "gql" as const,
      query: formula(
        "from table ",
        table("payments"),
        ...(!oneBill ? ["\nleft join table ", table("bills"), " as bill on ", field("payments.bill"), " = bill.id"] : []),
        "\nselect ",
        ...(!oneBill ? [field("payments.bill"), ", bill.", field("bills.party_name"), ", "] : []),
        field("payments.date"),
        ", ",
        field("payments.amount"),
        ", ",
        field("payments.refund"),
        ", ",
        field("payments.reference"),
        "\nwhere ",
        ...(oneBill ? [field("payments.bill"), " = @params.bill_id and "] : []),
        `record.finalizationState = '${confirmed ? "finalized" : "draft"}'\nsort record.createdAt desc`,
      ),
    },
    display: {
      kind: "table" as const,
      columnIds: [],
      mobile: {
        titleColumnId: oneBill ? t.date : t.bills,
        detailColumnIds: [t.amount, t.refund, t.reference],
      },
    },
    searchable: !oneBill,
    pageSize: 25,
    rowNavigate: {
      kind: "navigate" as const,
      pageId: "payment",
      history: "push" as const,
      params: { payment_id: { source: "ROW" as const, path: "id" as const } },
    },
    ...(!confirmed ? { rowActions: paymentActions("ROW").map((action) => ({ ...action, showLabel: true })) } : {}),
    ...(oneBill
      ? {
          availableWhen: confirmed
            ? billPaymentWhen
            : {
                query: formula(
                  "from table ",
                  table("payments"),
                  "\nselect ",
                  field("payments.amount"),
                  "\nwhere ",
                  field("payments.bill"),
                  " = @params.bill_id and record.finalizationState = 'draft'\nlimit 1",
                ),
              },
        }
      : {}),
  });
  const issueKinds = [
    { kind: "invoice", form: "edit_draft", id: "issue", launcher: "issue_invoice", label: t.issueInvoiceAction, confirm: t.issueConfirm },
    {
      kind: "creditNote",
      form: "edit_correction",
      id: "issue-correction",
      launcher: "issue_correction",
      label: t.issueCorrectionAction,
      confirm: t.issueCorrectionConfirm,
    },
    {
      kind: "selfBilling",
      form: "edit_self_billing",
      id: "issue-self-billing",
      launcher: "issue_self_billing",
      label: t.issueSelfBillingAction,
      confirm: t.issueSelfBillingConfirm,
    },
  ];
  const issueAction = (entry: (typeof issueKinds)[number]) => ({
    id: entry.id,
    kind: "workflow" as const,
    label: entry.label,
    icon: "lock",
    variant: "primary" as const,
    launcherId: launcher(entry.launcher),
    inputs: { bill: { source: "RECORD" as const, path: "id" as const } },
    confirm: entry.confirm,
    background: { acceptedMessage: t.creationAccepted, documentBlockId: "identity", documentTemplateId: documentTemplate("billing") },
  });
  const identity = {
    id: "identity",
    type: "record" as const,
    fieldIds: [field("bills.party_name"), field("bills.party_number"), field("bills.kind")],
    editableFieldIds: [],
    layout: "compact" as const,
    heading: { fieldId: field("bills.party_name"), documentNumber: true, title: t.draftWorkspaceTitle },
    documents: { templateIds: [documentTemplate("billing")], preview: true },
  };
  return [
    {
      key: "billing",
      definition: {
        schemaVersion: 5,
        kind: "grids.custom-app",
        name: t.title,
        icon: "receipt",
        startPageId: "invoices",
        sidebar: {
          actions: [
            {
              id: "new",
              kind: "form",
              label: t.newInvoice,
              icon: "plus",
              tone: "success",
              formId: form("new_invoice"),
              fixedValues: {},
              onSuccessNavigate: resultNavigation,
            },
            {
              id: "self-billing",
              kind: "form",
              label: t.newSelfBilling,
              icon: "receipt",
              tone: "default",
              formId: form("new_self_billing"),
              fixedValues: {},
              onSuccessNavigate: resultNavigation,
            },
          ],
        },
        pages: [
          {
            id: "invoices",
            title: t.bills,
            navigation: { visible: true, icon: "receipt" },
            parameters: {},
            rows: [
              {
                id: "work",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "start-help", type: "markdown", markdown: t.startHelp },
                      ...[false, true].map((issued) => ({
                        id: issued ? "bills" : "drafts",
                        type: "records" as const,
                        title: issued ? t.issued : t.drafts,
                        workflowStatus: true,
                        emptyText: issued ? t.noIssued : t.noDrafts,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("bills"),
                            "\nselect ",
                            field("bills.party_name"),
                            ", ",
                            field("bills.kind"),
                            ", ",
                            field("bills.invoice_date"),
                            ", ",
                            field("bills.gross"),
                            `\nwhere record.finalizationState = '${issued ? "finalized" : "draft"}'\nsort record.createdAt desc`,
                          ),
                        },
                        display: {
                          kind: "table" as const,
                          columnIds: [],
                          mobile: {
                            titleColumnId: t.recipientSection,
                            detailColumnIds: [t.kind, t.invoiceDate, totalLabel],
                          },
                        },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate" as const,
                          pageId: "bill",
                          history: "push" as const,
                          params: { bill_id: { source: "ROW" as const, path: "id" as const } },
                        },
                      })),
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "bill",
            title: t.documentDetails,
            navigation: { visible: false },
            parameters: billParams,
            record: billRecord,
            rows: [
              {
                id: "identity",
                columns: [{ id: "identity-main", span: 12, blocks: [identity] }],
              },
              {
                id: "editing",
                columns: [
                  {
                    id: "editor",
                    span: 12,
                    blocks: [
                      {
                        id: "reuse-help",
                        type: "markdown",
                        markdown: t.reuseHelp,
                        availableWhen: {
                          query: formula(
                            "from table ",
                            table("bills"),
                            "\nselect ",
                            field("bills.reference"),
                            "\nwhere record.id = @params.bill_id and record.finalizationState = 'draft' and ",
                            field("bills.kind"),
                            " = 'invoice' and ISBLANK(",
                            field("bills.service_date"),
                            ")\nlimit 1",
                          ),
                        },
                      },
                      {
                        id: "correction-origin",
                        type: "record",
                        title: t.originalContext,
                        heading: { fieldId: field("bills.original_number") },
                        layout: "context",
                        fieldIds: [field("bills.original_number"), field("bills.original_date")],
                        editableFieldIds: [],
                        availableWhen: billWhen(undefined, "creditNote"),
                      },
                      {
                        id: "correction-reason",
                        type: "record",
                        fieldIds: [field("bills.reason")],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized", "creditNote"),
                      },
                      ...issueKinds.flatMap((entry) => [
                        {
                          id: entry.form.replaceAll("_", "-"),
                          type: "form" as const,
                          formId: form(entry.form),
                          mode: "edit" as const,
                          fixedValues: {},
                          actionsBlockId: `${entry.id}-actions`,
                          workspace: {
                            summaryTitle:
                              entry.kind === "creditNote"
                                ? t.correctionSummary
                                : entry.kind === "selfBilling"
                                  ? t.settlementSummary
                                  : t.invoiceSummary,
                            summaryDescription:
                              entry.kind === "creditNote"
                                ? t.correctionSummaryHelp
                                : entry.kind === "selfBilling"
                                  ? t.settlementSummaryHelp
                                  : t.invoiceSummaryHelp,
                            helpTitle: t.inheritedDetails,
                            helpText: t.startHelp,
                          },
                          onSuccessNavigate: billNavigation,
                          availableWhen: billWhen("draft", entry.kind),
                        },
                        {
                          id: `${entry.id}-actions`,
                          type: "actions" as const,
                          // Issuance remains authorized after its own finalization step.
                          // Without the draft form this becomes the document action strip.
                          availableWhen: billWhen(undefined, entry.kind),
                          actions: [
                            issueAction(entry),
                            {
                              id: "discard",
                              kind: "workflow" as const,
                              label: t.discardDraft,
                              icon: "trash",
                              variant: "danger" as const,
                              launcherId: launcher("discard_draft"),
                              inputs: { bill: { source: "RECORD" as const, path: "id" as const } },
                              confirm: t.discardDraftConfirm,
                              availableWhen: billWhen("draft", entry.kind),
                              onSuccessNavigate: { kind: "navigate" as const, pageId: "invoices", params: {} },
                            },
                          ],
                        },
                      ]),
                    ],
                  },
                ],
              },
              {
                id: "details",
                columns: [
                  {
                    id: "main",
                    span: 8,
                    blocks: [
                      {
                        id: "balance",
                        type: "metrics",
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR" },
                        source: { kind: "gql", query: openBalance },
                        availableWhen: { query: openBalance },
                      },
                      {
                        id: "credit-balance",
                        type: "metrics",
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR" },
                        source: { kind: "gql", query: creditBalance },
                        availableWhen: { query: creditBalance },
                      },
                      {
                        id: "refund-entry",
                        type: "actions",
                        actions: [
                          {
                            id: "refund",
                            kind: "workflow",
                            label: t.refundForm,
                            icon: "arrow-back-up",
                            variant: "primary",
                            launcherId: launcher("record_refund"),
                            inputs: { bill: { source: "RECORD", path: "id" } },
                            prompt: {
                              inputs: ["date", "amount", "reference"],
                              description: t.refundHelp,
                              successMessage: t.refundRecorded,
                            },
                          },
                        ],
                        availableWhen: {
                          query: billingBalanceSource(t, true, { metrics: "outstanding", group: "credits", invoiceOnly: true }),
                        },
                      },
                      {
                        id: "settled-balance",
                        type: "markdown",
                        markdown: t.settledBalance,
                        availableWhen: { query: billingBalanceSource(t, true, { metrics: "outstanding", group: "settled" }) },
                      },
                      {
                        id: "due-date",
                        type: "record",
                        layout: "compact",
                        fieldIds: [field("bills.due_date")],
                        relativeDates: [field("bills.due_date")],
                        editableFieldIds: [],
                        availableWhen: { query: openBalance },
                      },
                      {
                        id: "payment-entry",
                        type: "actions",
                        actions: paymentEntryActions("primary"),
                        availableWhen: { query: openBalance },
                      },
                      {
                        id: "secondary-payment-entry",
                        type: "actions",
                        actions: paymentEntryActions("secondary"),
                        availableWhen: { query: billingBalanceSource(t, true, { metrics: "outstanding", group: "nonpositive" }) },
                      },
                      payments(false, true),
                      {
                        id: "frozen",
                        type: "record",
                        fieldIds: [field("bills.positions")],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized"),
                      },
                      {
                        id: "totals",
                        type: "record",
                        layout: "summary",
                        fieldIds: [field("bills.net"), field("bills.tax"), field("bills.gross")],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized"),
                      },
                      payments(true, true),
                    ],
                  },
                  {
                    id: "context",
                    span: 4,
                    blocks: [
                      {
                        id: "invoice-facts",
                        type: "record",
                        title: t.frozen,
                        layout: "rows",
                        fieldIds: [field("bills.invoice_date"), field("bills.service_date"), field("bills.buyer_reference")],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized"),
                      },
                      {
                        id: "other-actions",
                        type: "actions",
                        availableWhen: billWhen("finalized", "invoice"),
                        actions: [
                          {
                            id: "new-correction",
                            kind: "workflow",
                            label: t.newCorrection,
                            icon: "receipt-refund",
                            variant: "secondary",
                            launcherId: launcher("new_correction"),
                            inputs: { bill: { source: "RECORD", path: "id" } },
                            onSuccessNavigate: resultNavigation,
                          },
                          {
                            id: "reuse-invoice",
                            kind: "workflow",
                            label: t.reuseInvoice,
                            icon: "copy",
                            variant: "secondary",
                            launcherId: launcher("reuse_invoice"),
                            inputs: { bill: { source: "RECORD", path: "id" } },
                            onSuccessNavigate: resultNavigation,
                          },
                        ],
                      },
                      {
                        id: "notes",
                        type: "record",
                        layout: "rows",
                        fieldIds: [field("bills.notes")],
                        editableFieldIds: [],
                        availableWhen: {
                          query: formula(
                            "from table ",
                            table("bills"),
                            "\nselect ",
                            field("bills.reference"),
                            "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized' and not ISBLANK(",
                            field("bills.notes"),
                            ")\nlimit 1",
                          ),
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "balances",
            title: t.balances,
            navigation: { visible: true, icon: "cash" },
            parameters: {},
            rows: [
              {
                id: "work",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "pending-payments-help",
                        type: "markdown",
                        markdown: `:::info ${t.pendingPayments}\n${t.pendingPaymentsHelp}\n:::`,
                      },
                      payments(false, false),
                      ...(
                        [
                          { group: "overdue", title: t.overdue, emptyText: t.noOverdue, help: t.overdueHelp },
                          { group: "upcoming", title: t.upcoming, emptyText: t.noUpcoming, help: t.upcomingHelp },
                          { group: "credits", title: t.credits, emptyText: t.noCredits, help: t.creditsHelp },
                        ] as const
                      ).flatMap(({ group, title, emptyText, help }) => [
                        { id: `${group}-help`, type: "markdown" as const, markdown: `:::info ${title}\n${help}\n:::` },
                        {
                          id: group,
                          type: "records" as const,
                          title,
                          emptyText,
                          source: { kind: "gql" as const, query: billingBalanceSource(t, false, { group }) },
                          display: {
                            kind: "table" as const,
                            columnIds: [],
                            relativeDateColumnIds: [t.dueDate],
                            mobile: { titleColumnId: t.recipientSection, detailColumnIds: [t.dueDate, t.outstanding] },
                          },
                          searchable: true,
                          pageSize: 25,
                          rowNavigate: {
                            kind: "navigate" as const,
                            pageId: "bill",
                            history: "push" as const,
                            params: { bill_id: { source: "ROW" as const, path: "id" as const } },
                          },
                        },
                      ]),
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "partners",
            title: t.parties,
            navigation: { visible: true, icon: "address-book" },
            parameters: {},
            rows: [
              {
                id: "partners",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "new",
                        type: "actions",
                        actions: [
                          {
                            id: "new",
                            kind: "navigate",
                            label: t.newPartner,
                            icon: "plus",
                            variant: "primary",
                            pageId: "partner-new",
                            history: "push",
                            params: {},
                          },
                        ],
                      },
                      {
                        id: "partners",
                        type: "records",
                        title: t.parties,
                        emptyText: t.noPartners,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("parties"),
                            "\nselect ",
                            field("parties.number"),
                            ", ",
                            field("parties.name"),
                            ", ",
                            field("parties.city"),
                            ", ",
                            field("parties.vat_id"),
                            "\nsort ",
                            field("parties.number"),
                            ", ",
                            field("parties.name"),
                            " asc",
                          ),
                        },
                        display: { kind: "table", columnIds: [] },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate",
                          pageId: "partner",
                          history: "push",
                          params: { partner_id: { source: "ROW", path: "id" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "partner",
            title: t.party,
            navigation: { visible: false },
            parameters: { partner_id: { type: "record", tableId: table("parties"), required: true } },
            record: { tableId: table("parties"), id: { source: "PARAMS", path: "partner_id" } },
            rows: [
              {
                id: "partner",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "identity",
                        type: "record",
                        fieldIds: [field("parties.name"), field("parties.number")],
                        heading: { fieldId: field("parties.name") },
                        editableFieldIds: [],
                      },
                      { id: "help", type: "markdown", markdown: t.partnerHelp },
                      {
                        id: "edit",
                        type: "form",
                        formId: form("partner"),
                        mode: "edit",
                        fixedValues: {},
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "partner",
                          params: { partner_id: { source: "PARAMS", path: "partner_id" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "partner-new",
            title: t.newPartner,
            navigation: { visible: false },
            parameters: {},
            rows: [
              {
                id: "partner",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "form",
                        type: "form",
                        formId: form("partner"),
                        mode: "create",
                        fixedValues: {},
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "partner",
                          params: { partner_id: { source: "RESULT", path: "recordId" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "payment",
            title: t.payments,
            navigation: { visible: false },
            parameters: { payment_id: { type: "record", tableId: table("payments"), required: true } },
            record: { tableId: table("payments"), id: { source: "PARAMS", path: "payment_id" } },
            rows: [
              {
                id: "payment",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "back",
                        type: "actions",
                        actions: [
                          {
                            id: "back",
                            kind: "navigate",
                            label: t.backToBill,
                            icon: "arrow-left",
                            variant: "secondary",
                            pageId: "bill",
                            history: "push",
                            params: { bill_id: { source: "RECORD", path: "relation", fieldId: field("payments.bill") } },
                          },
                        ],
                      },
                      {
                        id: "payment-context",
                        type: "record",
                        layout: "compact",
                        fieldIds: [
                          field("payments.bill"),
                          field("payments.date"),
                          field("payments.amount"),
                          field("payments.refund"),
                          field("payments.reference"),
                        ],
                        editableFieldIds: [],
                        availableWhen: paymentWhen("draft"),
                      },
                      {
                        id: "pending",
                        type: "markdown",
                        markdown: `:::info ${t.pendingPayments}\n${t.paymentPendingHelp}\n:::`,
                        availableWhen: paymentWhen("draft"),
                      },
                      {
                        id: "edit",
                        type: "form",
                        formId: form("edit_payment"),
                        mode: "edit",
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.editPayment, icon: "pencil", variant: "secondary" },
                        availableWhen: paymentWhen("draft"),
                      },
                      {
                        id: "actions",
                        type: "actions",
                        actions: paymentActions("RECORD").map((action) =>
                          action.id === "discard"
                            ? { ...action, onSuccessNavigate: { kind: "navigate" as const, pageId: "balances", params: {} } }
                            : action,
                        ),
                        availableWhen: paymentWhen("draft"),
                      },
                      { id: "confirmed", type: "markdown", markdown: t.paymentConfirmedHelp, availableWhen: paymentWhen("finalized") },
                      {
                        id: "details",
                        type: "record",
                        fieldIds: [
                          field("payments.bill"),
                          field("payments.date"),
                          field("payments.amount"),
                          field("payments.refund"),
                          field("payments.reference"),
                        ],
                        editableFieldIds: [],
                        availableWhen: paymentWhen("finalized"),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ];
};
