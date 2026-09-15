import type { BillingText } from "./billing";
import { billingBalanceSource } from "./billing-balances";
import { documentTemplate, field, fieldKey, form, formula, type GridTemplate, launcher, table } from "./types";

export const billingApp = (t: BillingText): NonNullable<GridTemplate["customApps"]> => [
  {
    key: "billing",
    definition: {
      schemaVersion: 5,
      kind: "grids.custom-app",
      name: t.title,
      icon: "receipt",
      startPageId: "drafts",
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
            onSuccessNavigate: { kind: "navigate", pageId: "bill", params: { bill_id: { source: "RESULT", path: "recordId" } } },
          },
          {
            id: "self-billing",
            kind: "form",
            label: t.newSelfBilling,
            icon: "receipt",
            tone: "default",
            formId: form("new_self_billing"),
            fixedValues: {},
            onSuccessNavigate: { kind: "navigate", pageId: "bill", params: { bill_id: { source: "RESULT", path: "recordId" } } },
          },
        ],
      },
      pages: [
        {
          id: "refund-new",
          title: t.refundForm,
          navigation: { visible: false },
          parameters: { bill_id: { type: "record", tableId: table("bills"), required: true } },
          record: { tableId: table("bills"), id: { source: "PARAMS", path: "bill_id" } },
          availableWhen: {
            query: formula(
              "from table ",
              table("bills"),
              "\nselect ",
              field("bills.reference"),
              "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized' and ",
              field("bills.kind"),
              " = 'invoice'\nlimit 1",
            ),
          },
          rows: [
            {
              id: "refund",
              columns: [
                {
                  id: "content",
                  span: 12,
                  blocks: [
                    {
                      id: "identity",
                      type: "record",
                      fieldIds: [field("bills.reference"), field("bills.party_name")],
                      editableFieldIds: [],
                    },
                    { id: "help", type: "markdown", markdown: t.paymentHelp },
                    {
                      id: "form",
                      type: "form",
                      formId: form("refund"),
                      mode: "create",
                      fixedValues: { [fieldKey("payments.bill")]: { source: "RECORD", path: "id" } },
                      onSuccessNavigate: {
                        kind: "navigate",
                        pageId: "payment",
                        params: { payment_id: { source: "RESULT", path: "recordId" } },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "drafts",
          title: t.drafts,
          navigation: { visible: true },
          parameters: {},
          rows: [
            {
              id: "list",
              columns: [
                {
                  id: "content",
                  span: 12,
                  blocks: [
                    {
                      id: "start-help",
                      type: "markdown" as const,
                      markdown: t.startHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("settings"),
                          "\nselect ",
                          field("settings.ready"),
                          "\nwhere ",
                          field("settings.ready"),
                          " = false\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "start-action",
                      type: "actions" as const,
                      actions: [
                        {
                          id: "setup",
                          kind: "navigate" as const,
                          label: t.setupAction,
                          icon: "settings",
                          pageId: "settings",
                          history: "push" as const,
                          params: {},
                        },
                      ],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("settings"),
                          "\nselect ",
                          field("settings.ready"),
                          "\nwhere ",
                          field("settings.ready"),
                          " = false\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "bills",
                      type: "records" as const,
                      title: t.drafts,
                      emptyText: t.noBills,
                      source: {
                        kind: "gql" as const,
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          ", ",
                          field("bills.party_name"),
                          ", ",
                          field("bills.kind"),
                          ", ",
                          field("bills.invoice_date"),
                          ", ",
                          field("bills.gross"),
                          "\nwhere record.finalizationState = 'draft'\nsort record.createdAt desc",
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
                      rowActions: [
                        {
                          id: "discard",
                          kind: "workflow",
                          label: t.discardDraft,
                          icon: "trash",
                          showLabel: true,
                          launcherId: launcher("discard_draft"),
                          inputs: { bill: { source: "ROW", path: "id" } },
                          confirm: t.discardDraftConfirm,
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
          title: t.bills,
          navigation: { visible: false },
          parameters: { bill_id: { type: "record", tableId: table("bills"), required: true } },
          record: { tableId: table("bills"), id: { source: "PARAMS", path: "bill_id" } },
          rows: [
            {
              id: "content",
              columns: [
                {
                  id: "main",
                  span: 12,
                  blocks: [
                    {
                      id: "identity",
                      type: "record",
                      fieldIds: [field("bills.reference")],
                      editableFieldIds: [],
                      documents: { templateIds: [documentTemplate("billing")], preview: true },
                    },
                    {
                      id: "correction-help",
                      type: "markdown",
                      markdown: t.correctionHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and ",
                          field("bills.kind"),
                          " = 'creditNote'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "correction-origin",
                      type: "record",
                      fieldIds: [field("bills.original"), field("bills.original_number")],
                      editableFieldIds: [],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and ",
                          field("bills.kind"),
                          " = 'creditNote'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "saved",
                      type: "record",
                      title: t.savedDetails,
                      fieldIds: [
                        field("bills.party_name"),
                        field("bills.invoice_date"),
                        field("bills.service_date"),
                        field("bills.due_date"),
                        field("bills.positions"),
                        field("bills.net"),
                        field("bills.tax"),
                        field("bills.gross"),
                      ],
                      editableFieldIds: [],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'draft'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "frozen",
                      type: "record",
                      title: t.frozen,
                      fieldIds: [
                        field("bills.invoice_date"),
                        field("bills.positions"),
                        field("bills.net"),
                        field("bills.tax"),
                        field("bills.gross"),
                      ],
                      editableFieldIds: [],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "settlement-help",
                      type: "markdown",
                      markdown: t.settlementHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and ",
                          field("bills.kind"),
                          " = 'selfBilling'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "balance",
                      type: "records",
                      title: t.balances,
                      source: { kind: "gql", query: billingBalanceSource(t, true) },
                      display: { kind: "table", columnIds: [] },
                      searchable: false,
                      pageSize: 5,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "actions",
                      type: "actions",
                      actions: [
                        {
                          id: "edit",
                          kind: "navigate",
                          label: t.editDraft,
                          icon: "edit",
                          pageId: "bill-details",
                          history: "push",
                          params: { bill_id: { source: "RECORD", path: "id" } },
                          availableWhen: {
                            query: formula(
                              "from table ",
                              table("bills"),
                              "\nselect ",
                              field("bills.reference"),
                              "\nwhere record.id = @params.bill_id and record.finalizationState = 'draft'\nlimit 1",
                            ),
                          },
                        },
                        {
                          id: "issue-self-billing",
                          kind: "workflow",
                          label: t.issueSelfBillingAction,
                          icon: "lock",
                          launcherId: launcher("issue_self_billing"),
                          inputs: { bill: { source: "RECORD", path: "id" } },
                          confirm: t.issueSelfBillingConfirm,
                          availableWhen: {
                            query: formula(
                              "from table ",
                              table("bills"),
                              "\nselect ",
                              field("bills.reference"),
                              "\nwhere record.id = @params.bill_id and ",
                              field("bills.kind"),
                              " = 'selfBilling'\nlimit 1",
                            ),
                          },
                        },
                        {
                          id: "new-correction",
                          kind: "workflow",
                          label: t.newCorrection,
                          icon: "receipt-refund",
                          launcherId: launcher("new_correction"),
                          inputs: { bill: { source: "RECORD", path: "id" } },
                          availableWhen: {
                            query: formula(
                              "from table ",
                              table("bills"),
                              "\nselect ",
                              field("bills.reference"),
                              "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized' and ",
                              field("bills.kind"),
                              " = 'invoice'\nlimit 1",
                            ),
                          },
                        },
                        {
                          id: "issue-correction",
                          kind: "workflow",
                          label: t.issueCorrectionAction,
                          icon: "lock",
                          launcherId: launcher("issue_correction"),
                          inputs: { bill: { source: "RECORD", path: "id" } },
                          confirm: t.issueCorrectionConfirm,
                          availableWhen: {
                            query: formula(
                              "from table ",
                              table("bills"),
                              "\nselect ",
                              field("bills.reference"),
                              "\nwhere record.id = @params.bill_id and ",
                              field("bills.kind"),
                              " = 'creditNote'\nlimit 1",
                            ),
                          },
                        },
                        {
                          id: "issue",
                          kind: "workflow",
                          label: t.issueInvoiceAction,
                          icon: "lock",
                          launcherId: launcher("issue_invoice"),
                          inputs: { bill: { source: "RECORD", path: "id" } },
                          confirm: t.issueConfirm,
                          availableWhen: {
                            query: formula(
                              "from table ",
                              table("bills"),
                              "\nselect ",
                              field("bills.reference"),
                              "\nwhere record.id = @params.bill_id and ",
                              field("bills.kind"),
                              " = 'invoice'\nlimit 1",
                            ),
                          },
                        },
                      ],
                    },
                    {
                      id: "payment-help",
                      type: "markdown",
                      markdown: t.paymentHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
                        ),
                      },
                    },
                    ...[false, true].map((confirmed) => ({
                      id: confirmed ? "payments" : "pending-payments",
                      type: "records" as const,
                      title: confirmed ? t.confirmedPayments : t.pendingPayments,
                      source: {
                        kind: "gql" as const,
                        query: formula(
                          "from table ",
                          table("payments"),
                          "\nselect ",
                          field("payments.date"),
                          ", ",
                          field("payments.amount"),
                          ", ",
                          field("payments.reference"),
                          "\nwhere ",
                          field("payments.bill"),
                          ` = @params.bill_id and record.finalizationState = '${confirmed ? "finalized" : "draft"}'\nsort record.createdAt desc`,
                        ),
                      },
                      display: { kind: "table" as const, columnIds: [] },
                      searchable: false,
                      pageSize: 25,
                      rowNavigate: {
                        kind: "navigate" as const,
                        pageId: "payment",
                        history: "push" as const,
                        params: { payment_id: { source: "ROW" as const, path: "id" as const } },
                      },
                    })),
                    {
                      id: "payment-action",
                      type: "actions",
                      actions: [
                        {
                          id: "payment",
                          kind: "navigate",
                          label: t.paymentForm,
                          icon: "plus",
                          pageId: "bill-details",
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
                        {
                          id: "refund",
                          kind: "navigate",
                          label: t.refundForm,
                          icon: "arrow-back-up",
                          pageId: "refund-new",
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
                              " = 'invoice'\nlimit 1",
                            ),
                          },
                        },
                      ],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
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
          id: "bill-details",
          title: t.documentDetails,
          navigation: { visible: false },
          parameters: { bill_id: { type: "record", tableId: table("bills"), required: true } },
          record: { tableId: table("bills"), id: { source: "PARAMS", path: "bill_id" } },
          rows: [
            {
              id: "edit",
              columns: [
                {
                  id: "main",
                  span: 12,
                  blocks: [
                    { id: "identity", type: "record", fieldIds: [field("bills.reference")], editableFieldIds: [] },
                    ...(
                      [
                        ["invoice", "edit_draft"],
                        ["creditNote", "edit_correction"],
                        ["selfBilling", "edit_self_billing"],
                      ] as const
                    ).map(([kind, key]) => ({
                      id: key.replaceAll("_", "-"),
                      type: "form" as const,
                      formId: form(key),
                      mode: "edit" as const,
                      fixedValues: {},
                      onSuccessNavigate: {
                        kind: "navigate" as const,
                        pageId: "bill",
                        params: { bill_id: { source: "RESULT" as const, path: "recordId" as const } },
                      },
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'draft' and ",
                          field("bills.kind"),
                          ` = '${kind}'\nlimit 1`,
                        ),
                      },
                    })),
                    {
                      id: "back",
                      type: "actions",
                      actions: [
                        {
                          id: "back",
                          kind: "navigate",
                          label: t.backToBill,
                          icon: "arrow-left",
                          pageId: "bill",
                          history: "push",
                          params: { bill_id: { source: "RECORD", path: "id" } },
                        },
                      ],
                    },
                    {
                      id: "help",
                      type: "markdown",
                      markdown: t.paymentHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "payment-form",
                      type: "form",
                      formId: form("payment"),
                      mode: "create",
                      fixedValues: { [fieldKey("payments.bill")]: { source: "RECORD", path: "id" } },
                      onSuccessNavigate: {
                        kind: "navigate",
                        pageId: "payment",
                        params: { payment_id: { source: "RESULT", path: "recordId" } },
                      },
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
                        ),
                      },
                    },
                    {
                      id: "frozen",
                      type: "record",
                      fieldIds: [field("bills.buyer_reference"), field("bills.notes")],
                      editableFieldIds: [],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("bills"),
                          "\nselect ",
                          field("bills.reference"),
                          "\nwhere record.id = @params.bill_id and record.finalizationState = 'finalized'\nlimit 1",
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
          navigation: { visible: true, icon: "calculator" },
          parameters: {},
          rows: [
            {
              id: "balances",
              columns: [
                {
                  id: "main",
                  span: 12,
                  blocks: [
                    { id: "finalized-help", type: "markdown", markdown: t.finalizedHelp },
                    {
                      id: "balances",
                      type: "records",
                      source: { kind: "gql", query: billingBalanceSource(t) },
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
                    { id: "payment-help", type: "markdown", markdown: t.paymentHelp },
                    ...[false, true].map((confirmed) => ({
                      id: confirmed ? "payments" : "pending-payments",
                      type: "records" as const,
                      title: confirmed ? t.confirmedPayments : t.pendingPayments,
                      source: {
                        kind: "gql" as const,
                        query: formula(
                          "from table ",
                          table("payments"),
                          "\nselect ",
                          field("payments.bill"),
                          ", ",
                          field("payments.date"),
                          ", ",
                          field("payments.amount"),
                          ", ",
                          field("payments.reference"),
                          `\nwhere record.finalizationState = '${confirmed ? "finalized" : "draft"}'\nsort record.createdAt desc`,
                        ),
                      },
                      display: { kind: "table" as const, columnIds: [] },
                      searchable: true,
                      pageSize: 25,
                      rowNavigate: {
                        kind: "navigate" as const,
                        pageId: "payment",
                        history: "push" as const,
                        params: { payment_id: { source: "ROW" as const, path: "id" as const } },
                      },
                    })),
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
                    { id: "help", type: "markdown", markdown: t.partnerHelp },
                    {
                      id: "partners",
                      type: "records",
                      source: {
                        kind: "gql",
                        query: formula(
                          "from table ",
                          table("parties"),
                          "\nselect ",
                          field("parties.name"),
                          ", ",
                          field("parties.vat_id"),
                          ", ",
                          field("parties.city"),
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
                    { id: "name", type: "record", fieldIds: [field("parties.name")], editableFieldIds: [] },
                    { id: "help", type: "markdown", markdown: t.partnerHelp },
                    { id: "edit", type: "form", formId: form("partner"), mode: "edit", fixedValues: {} },
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
                    },
                    ...[false, true].map((confirmed) => ({
                      id: confirmed ? "confirmed" : "pending",
                      type: "markdown" as const,
                      markdown: confirmed ? t.paymentConfirmedHelp : t.paymentPendingHelp,
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("payments"),
                          "\nselect ",
                          field("payments.amount"),
                          `\nwhere record.id = @params.payment_id and record.finalizationState = '${confirmed ? "finalized" : "draft"}'\nlimit 1`,
                        ),
                      },
                    })),
                    {
                      id: "actions",
                      type: "actions",
                      actions: [
                        {
                          id: "edit",
                          kind: "navigate",
                          label: t.editDraft,
                          icon: "edit",
                          pageId: "payment-edit",
                          history: "push",
                          params: { payment_id: { source: "RECORD", path: "id" } },
                        },
                        {
                          id: "confirm",
                          kind: "workflow",
                          label: t.confirmPayment,
                          icon: "lock",
                          launcherId: launcher("confirm_payment"),
                          inputs: { payment: { source: "RECORD", path: "id" } },
                          confirm: t.confirmPaymentMessage,
                        },
                        {
                          id: "discard",
                          kind: "workflow",
                          label: t.discardPayment,
                          icon: "trash",
                          launcherId: launcher("discard_payment"),
                          inputs: { payment: { source: "RECORD", path: "id" } },
                          confirm: t.discardDraftConfirm,
                        },
                      ],
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("payments"),
                          "\nselect ",
                          field("payments.amount"),
                          "\nwhere record.id = @params.payment_id and record.finalizationState = 'draft'\nlimit 1",
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
          id: "payment-edit",
          title: t.editDraft,
          navigation: { visible: false },
          parameters: { payment_id: { type: "record", tableId: table("payments"), required: true } },
          record: { tableId: table("payments"), id: { source: "PARAMS", path: "payment_id" } },
          rows: [
            {
              id: "edit",
              columns: [
                {
                  id: "main",
                  span: 12,
                  blocks: [
                    { id: "identity", type: "record", fieldIds: [field("payments.bill")], editableFieldIds: [] },
                    { id: "help", type: "markdown", markdown: t.paymentPendingHelp },
                    {
                      id: "edit",
                      type: "form",
                      formId: form("payment"),
                      mode: "edit",
                      fixedValues: {},
                      availableWhen: {
                        query: formula(
                          "from table ",
                          table("payments"),
                          "\nselect ",
                          field("payments.amount"),
                          "\nwhere record.id = @params.payment_id and record.finalizationState = 'draft'\nlimit 1",
                        ),
                      },
                      onSuccessNavigate: {
                        kind: "navigate",
                        pageId: "payment",
                        params: { payment_id: { source: "RESULT", path: "recordId" } },
                      },
                    },
                    {
                      id: "back",
                      type: "actions",
                      actions: [
                        {
                          id: "back",
                          kind: "navigate",
                          label: t.payments,
                          pageId: "payment",
                          history: "push",
                          params: { payment_id: { source: "RECORD", path: "id" } },
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
          id: "settings",
          title: t.settings,
          navigation: { visible: true, icon: "settings" },
          parameters: {},
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
                      id: "company",
                      type: "records",
                      source: {
                        kind: "gql",
                        query: formula(
                          "from table ",
                          table("settings"),
                          "\nselect ",
                          field("settings.name"),
                          ", ",
                          field("settings.ready"),
                          "\nwhere ",
                          field("settings.key"),
                          " = 'issuer'",
                        ),
                      },
                      display: { kind: "table", columnIds: [] },
                      searchable: false,
                      pageSize: 5,
                      rowNavigate: {
                        kind: "navigate",
                        pageId: "setup",
                        history: "push",
                        params: { settings_id: { source: "ROW", path: "id" } },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "setup",
          title: t.settings,
          navigation: { visible: false },
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
                    { id: "company-name", type: "record", fieldIds: [field("settings.name")], editableFieldIds: [] },
                    { id: "form", type: "form", formId: form("setup"), mode: "edit", fixedValues: {} },
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
