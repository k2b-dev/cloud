import type { BillingText } from "./billing";
import { billingBalanceSource } from "./billing-balances";
import { documentTemplate, field, fieldKey, form, formula, type GridTemplate, launcher, record, table } from "./types";

/** A document keeps one workspace from editable draft to issued document. */
export const billingApp = (t: BillingText): NonNullable<GridTemplate["customApps"]> => {
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
  const billSetupWhen = {
    query: formula(
      "from table ",
      table("bills"),
      " as bill\njoin table ",
      table("settings"),
      " as company on ",
      field("bills.settings"),
      " = company.id\nselect ",
      field("bills.reference"),
      "\nwhere record.id = @params.bill_id and record.finalizationState = 'draft' and company.",
      field("settings.ready"),
      " = false\nlimit 1",
    ),
  };
  const paymentWhen = (state: "draft" | "finalized") => ({
    query: formula(
      "from table ",
      table("payments"),
      "\nselect ",
      field("payments.amount"),
      `\nwhere record.id = @params.payment_id and record.finalizationState = '${state}'\nlimit 1`,
    ),
  });
  const setupWhen = {
    query: formula(
      "from table ",
      table("settings"),
      "\nselect ",
      field("settings.ready"),
      "\nwhere ",
      field("settings.ready"),
      " = false\nlimit 1",
    ),
  };
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
        "\nselect ",
        ...(!oneBill ? [field("payments.bill"), ", "] : []),
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
    display: { kind: "table" as const, columnIds: [] },
    searchable: !oneBill,
    pageSize: 25,
    rowNavigate: {
      kind: "navigate" as const,
      pageId: "payment",
      history: "push" as const,
      params: { payment_id: { source: "ROW" as const, path: "id" as const } },
    },
    ...(!confirmed ? { rowActions: paymentActions("ROW").map((action) => ({ ...action, showLabel: true })) } : {}),
    ...(oneBill ? { availableWhen: billPaymentWhen } : {}),
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
    fieldIds: [field("bills.party_name"), field("bills.kind")],
    editableFieldIds: [],
    heading: { fieldId: field("bills.party_name"), documentNumber: true },
    documents: { templateIds: [documentTemplate("billing")], preview: true },
  };
  const backToBill = {
    id: "back",
    type: "actions" as const,
    actions: [
      {
        id: "back",
        kind: "navigate" as const,
        label: t.backToBill,
        icon: "arrow-left",
        variant: "secondary" as const,
        pageId: "bill",
        history: "push" as const,
        params: { bill_id: { source: "PARAMS" as const, path: "bill_id" } },
      },
    ],
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
                      { id: "start-help", type: "markdown", markdown: t.startHelp, availableWhen: setupWhen },
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
                        display: { kind: "table" as const, columnIds: [] },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate" as const,
                          pageId: "bill",
                          history: "push" as const,
                          params: { bill_id: { source: "ROW" as const, path: "id" as const } },
                        },
                      })),
                      {
                        id: "other-document",
                        type: "actions",
                        actions: [
                          {
                            id: "self-billing",
                            kind: "navigate",
                            label: t.newSelfBilling,
                            icon: "receipt",
                            variant: "secondary",
                            pageId: "self-billing-new",
                            history: "push",
                            params: {},
                          },
                        ],
                      },
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
                id: "workspace",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      identity,
                      { id: "setup-help", type: "markdown", markdown: t.startHelp, availableWhen: billSetupWhen },
                      {
                        id: "correction-help",
                        type: "markdown",
                        markdown: t.correctionHelp,
                        availableWhen: billWhen("draft", "creditNote"),
                      },
                      {
                        id: "correction-origin",
                        type: "record",
                        fieldIds: [field("bills.original_number")],
                        editableFieldIds: [],
                        availableWhen: billWhen(undefined, "creditNote"),
                      },
                      {
                        id: "settlement-help",
                        type: "markdown",
                        markdown: t.settlementHelp,
                        availableWhen: billWhen("draft", "selfBilling"),
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
                      {
                        id: "balance",
                        type: "metrics",
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR" },
                        source: { kind: "gql", query: billingBalanceSource(t, true, { metrics: true }) },
                        availableWhen: billWhen("finalized"),
                      },
                      {
                        id: "payment-action",
                        type: "actions",
                        availableWhen: billPaymentWhen,
                        actions: [
                          {
                            id: "payment",
                            kind: "navigate",
                            label: t.paymentForm,
                            icon: "plus",
                            variant: "primary",
                            pageId: "payment-new",
                            history: "push",
                            params: { bill_id: { source: "RECORD", path: "id" } },
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("bills"),
                                "\nselect ",
                                field("bills.reference"),
                                "\nwhere record.id = @params.bill_id and ",
                                field("bills.kind"),
                                " != 'creditNote'\nlimit 1",
                              ),
                            },
                          },
                        ],
                      },
                      payments(false, true),
                      {
                        id: "frozen",
                        type: "record",
                        title: t.frozen,
                        fieldIds: [
                          field("bills.invoice_date"),
                          field("bills.service_date"),
                          field("bills.due_date"),
                          field("bills.buyer_reference"),
                          field("bills.positions"),
                          field("bills.net"),
                          field("bills.tax"),
                          field("bills.gross"),
                        ],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized"),
                      },
                      payments(true, true),
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
                            id: "refund",
                            kind: "navigate",
                            label: t.refundForm,
                            icon: "arrow-back-up",
                            variant: "secondary",
                            pageId: "refund-new",
                            history: "push",
                            params: { bill_id: { source: "RECORD", path: "id" } },
                          },
                        ],
                      },
                      {
                        id: "notes",
                        type: "record",
                        fieldIds: [field("bills.notes")],
                        editableFieldIds: [],
                        availableWhen: billWhen("finalized"),
                      },
                    ],
                  },
                ],
              },
            ],
          },
          ...([false, true] as const).map((refund) => ({
            id: refund ? "refund-new" : "payment-new",
            title: refund ? t.refundForm : t.paymentForm,
            navigation: { visible: false },
            parameters: billParams,
            record: billRecord,
            availableWhen: refund
              ? billWhen("finalized", "invoice")
              : {
                  query: formula(
                    "from table ",
                    table("bills"),
                    "\nselect ",
                    field("bills.reference"),
                    "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized' and ",
                    field("bills.kind"),
                    " != 'creditNote'\nlimit 1",
                  ),
                },
            rows: [
              {
                id: "entry",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      backToBill,
                      {
                        id: "identity",
                        type: "record" as const,
                        fieldIds: [field("bills.party_name"), field("bills.gross")],
                        heading: { fieldId: field("bills.party_name") },
                        editableFieldIds: [],
                      },
                      { id: "help", type: "markdown" as const, markdown: refund ? t.refundHelp : t.paymentHelp },
                      {
                        id: "form",
                        type: "form" as const,
                        formId: form(refund ? "refund" : "payment"),
                        mode: "create" as const,
                        fixedValues: { [fieldKey("payments.bill")]: { source: "RECORD" as const, path: "id" as const } },
                        onSuccessNavigate: billNavigation,
                      },
                    ],
                  },
                ],
              },
            ],
          })),
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
                      payments(false, false),
                      {
                        id: "balances",
                        type: "records",
                        title: t.balances,
                        emptyText: t.noBalances,
                        source: { kind: "gql", query: billingBalanceSource(t, false, { openOnly: true }) },
                        display: { kind: "table", columnIds: [] },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate",
                          pageId: "bill",
                          history: "push",
                          params: { bill_id: { source: "ROW", path: "id" } },
                        },
                      },
                      { id: "help", type: "markdown", markdown: t.balanceHelp },
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
                            field("parties.name"),
                            ", ",
                            field("parties.city"),
                            ", ",
                            field("parties.vat_id"),
                            "\nsort ",
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
                        fieldIds: [field("parties.name")],
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
                        fieldIds: [field("payments.bill"), field("payments.refund")],
                        editableFieldIds: [],
                        availableWhen: paymentWhen("draft"),
                      },
                      { id: "pending", type: "markdown", markdown: t.paymentPendingHelp, availableWhen: paymentWhen("draft") },
                      {
                        id: "edit",
                        type: "form",
                        formId: form("edit_payment"),
                        mode: "edit",
                        fixedValues: {},
                        actionsBlockId: "actions",
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "payment",
                          params: { payment_id: { source: "PARAMS", path: "payment_id" } },
                        },
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
          {
            id: "self-billing-new",
            title: t.newSelfBilling,
            navigation: { visible: false },
            parameters: {},
            rows: [
              {
                id: "settlement",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown", markdown: t.settlementHelp },
                      {
                        id: "form",
                        type: "form",
                        formId: form("new_self_billing"),
                        mode: "create",
                        fixedValues: {},
                        onSuccessNavigate: resultNavigation,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "settings",
            title: t.settings,
            navigation: { visible: true, icon: "building", recordId: record("settings") },
            parameters: { settings_id: { type: "record", tableId: table("settings"), required: true } },
            record: { tableId: table("settings"), id: { source: "PARAMS", path: "settings_id" } },
            rows: [
              {
                id: "setup",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown", markdown: t.setupHelp },
                      {
                        id: "form",
                        type: "form",
                        formId: form("setup"),
                        mode: "edit",
                        fixedValues: {},
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "settings",
                          params: { settings_id: { source: "PARAMS", path: "settings_id" } },
                        },
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
