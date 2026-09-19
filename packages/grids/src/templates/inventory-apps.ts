import type { InventoryText } from "./inventory";
import { documentTemplate, field, form, formula, type GridTemplate, launcher, table } from "./types";

/** Requests express equipment needs; the desk owns physical handovers and returns. */
export const inventoryApps = (t: InventoryText): NonNullable<GridTemplate["customApps"]> => {
  const loanParams = { loan_id: { type: "record" as const, tableId: table("loans"), required: true as const } };
  const loanRecord = { tableId: table("loans"), id: { source: "PARAMS" as const, path: "loan_id" as const } };
  const navigateLoan = {
    kind: "navigate" as const,
    pageId: "loan",
    params: { loan_id: { source: "RESULT" as const, path: "recordId" as const } },
  };
  const loanWhen = (statuses: string[]) => ({
    query: formula(
      "from table ",
      table("loans"),
      "\nwhere record.id = @params.loan_id and oneof(",
      field("loans.status"),
      `, ${statuses.map((status) => `'${status}'`).join(", ")})\nlimit 1`,
    ),
  });
  const loanList = (id: string, title: string, emptyText: string, statuses: string[], own = false, overdue = false) => ({
    id,
    type: "records" as const,
    title,
    emptyText,
    source: {
      kind: "gql" as const,
      query: formula(
        "from table ",
        table("loans"),
        "\nwhere oneof(",
        field("loans.status"),
        `, ${statuses.map((status) => `'${status}'`).join(", ")})`,
        own ? " and record.createdBy = @auth.id" : "",
        ...(overdue
          ? [" and ", field("loans.due_date"), " < @time.today"]
          : id === "loan-queue"
            ? [" and ", field("loans.due_date"), " >= @time.today"]
            : []),
        "\nselect ",
        field("loans.loan_no"),
        ", ",
        field(own ? "loans.purpose" : "loans.requester_name"),
        ", ",
        field("loans.start_date"),
        ", ",
        field("loans.due_date"),
        ", ",
        field("loans.status"),
        "\nsort ",
        field("loans.due_date"),
        " asc",
      ),
    },
    display: {
      kind: "table" as const,
      columnIds: [],
      relativeDateColumnIds: [t.dueDate],
      mobile: { titleColumnId: t.loanNumber, detailColumnIds: [own ? t.purpose : t.requesterName, t.dueDate, t.status] },
    },
    searchable: true,
    pageSize: 10,
    rowNavigate: {
      kind: "navigate" as const,
      history: "push" as const,
      pageId: "loan",
      params: { loan_id: { source: "ROW" as const, path: "id" as const } },
    },
  });
  const identity = {
    id: "identity",
    type: "record" as const,
    heading: { fieldId: field("loans.loan_no") },
    layout: "compact" as const,
    fieldIds: [field("loans.loan_no"), field("loans.requester_name"), field("loans.status")],
    editableFieldIds: [],
  };
  const requestForm = {
    id: "request",
    type: "form" as const,
    formId: form("request_loan"),
    fixedValues: {},
    presentation: { kind: "dialog" as const, label: t.newLoan, icon: "plus" },
    onSuccessNavigate: navigateLoan,
  };
  const requestedEquipment = {
    id: "requested-equipment",
    type: "record" as const,
    title: t.requestedEquipment,
    layout: "context" as const,
    fieldIds: [field("loans.kits"), field("loans.requested_items"), field("loans.purpose")],
    editableFieldIds: [],
  };
  const loanDates = {
    id: "dates",
    type: "record" as const,
    title: t.loanDates,
    layout: "summary" as const,
    fieldIds: [field("loans.start_date"), field("loans.due_date")],
    relativeDates: [field("loans.due_date")],
    editableFieldIds: [],
  };
  const loanDocuments = (preview: boolean) => ({
    id: "documents",
    type: "record" as const,
    title: t.loanDocuments,
    layout: "context" as const,
    fieldIds: [field("loans.loan_no")],
    editableFieldIds: [],
    documents: { templateIds: [documentTemplate("loan_agreement")], ...(preview ? { preview: true } : {}) },
    availableWhen: preview
      ? loanWhen(["approved", "active", "returned"])
      : {
          query: formula(
            "from table ",
            table("loans"),
            "\nwhere record.id = @params.loan_id and ",
            field("loans.agreement_sent"),
            " = 'sent'\nlimit 1",
          ),
        },
    disclosure: { label: t.loanDocuments },
  });
  const statusHelp = (desk: boolean) =>
    [
      { status: "requested", markdown: desk ? t.prepareHelp : t.requestedHelp },
      { status: "approved", markdown: desk ? t.handoverReadyHelp : t.approvedHelp },
      { status: "active", markdown: desk ? t.activeHelp : t.borrowedHelp },
      { status: "returned", markdown: t.returnedHelp },
      { status: "rejected", markdown: t.rejectedHelp },
      { status: "cancelled", markdown: t.cancelledHelp },
    ].map(({ status, markdown }) => ({
      id: `status-${status}`,
      type: "markdown" as const,
      markdown,
      availableWhen: loanWhen([status]),
    }));
  const requestedKitContents = {
    id: "requested-kit-contents",
    type: "records" as const,
    title: t.requestedKitContents,
    source: {
      kind: "gql" as const,
      query: formula(
        "from table ",
        table("loans"),
        "\njoin table ",
        table("kits"),
        " as kit on ",
        field("loans.kits"),
        " = kit.id\nwhere record.id = @params.loan_id\nselect kit.",
        field("kits.name"),
        ` as ${t.name}, kit.`,
        field("kits.items"),
        ` as ${t.kitContentsColumn}`,
      ),
    },
    display: { kind: "table" as const, columnIds: [], mobile: { titleColumnId: t.name, detailColumnIds: [t.kitContentsColumn] } },
    searchable: false,
    pageSize: 10,
    availableWhen: {
      query: formula("from table ", table("loans"), "\nwhere record.id = @params.loan_id and ", field("loans.kits"), " != null\nlimit 1"),
    },
    disclosure: { label: t.requestedKitContents },
  };
  const stock = {
    id: "stock",
    type: "records" as const,
    title: t.items,
    emptyText: t.emptyInventory,
    source: {
      kind: "gql" as const,
      query: formula(
        "from table ",
        table("items"),
        "\nselect ",
        field("items.name"),
        ", ",
        field("items.asset_id"),
        ", ",
        field("items.status"),
        ", ",
        field("items.location"),
        ", ",
        field("items.condition"),
        "\nsort ",
        field("items.name"),
        " asc",
      ),
    },
    display: {
      kind: "table" as const,
      columnIds: [],
      mobile: { titleColumnId: t.name, detailColumnIds: [t.assetId, t.status, t.location] },
    },
    searchable: true,
    pageSize: 25,
    rowNavigate: {
      kind: "navigate" as const,
      history: "push" as const,
      pageId: "item",
      params: { item_id: { source: "ROW" as const, path: "id" as const } },
    },
  };
  return [
    {
      key: "equipment_loans",
      definition: {
        schemaVersion: 5,
        kind: "grids.custom-app" as const,
        name: t.equipmentLoans,
        icon: "package",
        startPageId: "home",
        sidebar: {
          actions: [
            {
              id: "new-loan",
              kind: "form",
              tone: "success",
              label: t.newLoan,
              icon: "plus",
              formId: form("request_loan"),
              fixedValues: {},
              onSuccessNavigate: navigateLoan,
            },
          ],
        },
        pages: [
          {
            id: "home",
            title: t.myEquipmentLoans,
            navigation: { visible: true, icon: "home" },
            parameters: {},
            rows: [
              {
                id: "loans",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      { id: "guidance", type: "markdown" as const, markdown: t.equipmentLoansGuidance },
                      requestForm,
                      loanList("my-loans", t.myLoans, t.noEquipmentLoans, ["requested", "approved", "active"], true),
                      {
                        ...loanList("past-loans", t.loanArchive, t.emptyArchive, ["returned", "rejected", "cancelled"], true),
                        disclosure: { label: t.loanArchive },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "catalog",
            title: t.equipmentCatalog,
            navigation: { visible: true, icon: "package" },
            parameters: {},
            rows: [
              {
                id: "kits",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      { id: "guidance", type: "markdown" as const, markdown: t.catalogHelp },
                      requestForm,
                      {
                        id: "kits",
                        type: "records" as const,
                        title: t.kits,
                        emptyText: t.noKits,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("kits"),
                            "\nwhere ",
                            field("kits.requestable"),
                            " = true and ",
                            field("kits.status"),
                            " = 'available'\nselect ",
                            field("kits.name"),
                            ", ",
                            field("kits.description"),
                            ", ",
                            field("kits.category"),
                            "\nsort ",
                            field("kits.name"),
                            " asc",
                          ),
                        },
                        display: {
                          kind: "table" as const,
                          columnIds: [],
                          mobile: { titleColumnId: t.name, detailColumnIds: [t.description, t.category] },
                        },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate" as const,
                          history: "push" as const,
                          pageId: "kit",
                          params: { kit_id: { source: "ROW" as const, path: "id" as const } },
                        },
                      },
                      {
                        id: "items",
                        type: "records",
                        title: t.individualItems,
                        emptyText: t.noAvailableEquipment,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("items"),
                            "\nwhere ",
                            field("items.requestable"),
                            " = true and ",
                            field("items.status"),
                            " = 'available'\nselect ",
                            field("items.name"),
                            ", ",
                            field("items.asset_id"),
                            ", ",
                            field("items.category"),
                            "\nsort ",
                            field("items.name"),
                            " asc",
                          ),
                        },
                        display: {
                          kind: "table",
                          columnIds: [],
                          mobile: { titleColumnId: t.name, detailColumnIds: [t.assetId, t.category] },
                        },
                        searchable: true,
                        pageSize: 25,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "kit",
            title: t.kitDetails,
            navigation: { visible: false },
            parameters: { kit_id: { type: "record" as const, tableId: table("kits"), required: true as const } },
            record: { tableId: table("kits"), id: { source: "PARAMS" as const, path: "kit_id" as const } },
            availableWhen: {
              query: formula(
                "from table ",
                table("kits"),
                "\nwhere record.id = @params.kit_id and ",
                field("kits.requestable"),
                " = true and ",
                field("kits.status"),
                " = 'available'\nlimit 1",
              ),
            },
            rows: [
              {
                id: "kit",
                columns: [
                  {
                    id: "content",
                    span: 8,
                    blocks: [
                      {
                        id: "kit",
                        type: "record" as const,
                        heading: { fieldId: field("kits.name") },
                        layout: "rows" as const,
                        fieldIds: [field("kits.name"), field("kits.description"), field("kits.items")],
                        editableFieldIds: [],
                      },
                      requestForm,
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "loan",
            title: t.loanDetails,
            navigation: { visible: false },
            parameters: loanParams,
            record: loanRecord,
            availableWhen: {
              query: formula("from table ", table("loans"), "\nwhere record.id = @params.loan_id and record.createdBy = @auth.id\nlimit 1"),
            },
            rows: [
              {
                id: "identity",
                columns: [
                  { id: "content", span: 8, blocks: [identity, ...statusHelp(false)] },
                  { id: "schedule", span: 4, blocks: [loanDates] },
                ],
              },
              {
                id: "overview",
                columns: [
                  {
                    id: "request",
                    span: 8,
                    blocks: [
                      requestedEquipment,
                      requestedKitContents,
                      {
                        id: "assigned-equipment",
                        type: "records",
                        title: t.allocatedEquipment,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("loan_positions"),
                            "\nwhere ",
                            field("loan_positions.loan"),
                            " = @params.loan_id and ",
                            field("loan_positions.status"),
                            " != 'cancelled'\nselect ",
                            field("loan_positions.item"),
                            ", ",
                            field("loan_positions.status"),
                            ", ",
                            field("loan_positions.returned_at"),
                          ),
                        },
                        display: {
                          kind: "table",
                          columnIds: [],
                          mobile: { titleColumnId: t.positionItem, detailColumnIds: [t.status, t.returnedAt] },
                        },
                        searchable: false,
                        pageSize: 25,
                        availableWhen: loanWhen(["approved", "active", "returned"]),
                      },
                      {
                        id: "rejection",
                        type: "record",
                        title: t.rejectionReason,
                        layout: "context",
                        fieldIds: [field("loans.rejection_reason")],
                        editableFieldIds: [],
                        availableWhen: loanWhen(["rejected"]),
                      },
                      {
                        id: "actions",
                        type: "actions",
                        actions: [
                          {
                            id: "cancel",
                            label: t.cancelRequest,
                            variant: "secondary",
                            kind: "workflow",
                            launcherId: launcher("cancel_loan_custom_app"),
                            inputs: { loan: { source: "RECORD", path: "id" } },
                            confirm: t.cancelRequestConfirm,
                            availableWhen: loanWhen(["requested"]),
                          },
                        ],
                      },
                    ],
                  },
                  {
                    id: "context",
                    span: 4,
                    blocks: [
                      {
                        id: "details",
                        type: "record",
                        title: t.contactDetails,
                        layout: "rows",
                        fieldIds: [field("loans.requester_email"), field("loans.organization")],
                        editableFieldIds: [],
                        disclosure: { label: t.contactDetails },
                      },
                      loanDocuments(false),
                    ],
                  },
                ],
              },
              {
                id: "updates",
                columns: [{ id: "content", span: 8, blocks: [{ id: "comments", type: "comments", title: t.questionsAndUpdates }] }],
              },
            ],
          },
        ],
      },
    },
    {
      key: "loan_desk",
      definition: {
        schemaVersion: 5,
        kind: "grids.custom-app" as const,
        name: t.loanDesk,
        icon: "clipboard-check",
        startPageId: "dashboard",
        sidebar: {
          actions: [
            {
              id: "add-item",
              kind: "form" as const,
              tone: "default",
              label: t.addItem,
              icon: "plus",
              formId: form("add_item"),
              fixedValues: {},
              onSuccessNavigate: {
                kind: "navigate" as const,
                pageId: "item",
                params: { item_id: { source: "RESULT" as const, path: "recordId" as const } },
              },
            },
          ],
        },
        pages: [
          {
            id: "dashboard",
            title: t.loanDesk,
            navigation: { visible: true, icon: "clipboard-check" },
            parameters: {},
            rows: [
              {
                id: "work",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      { id: "guidance", type: "markdown" as const, markdown: t.deskHelp, disclosure: { label: t.loanAndHandover } },
                      loanList("overdue", t.overdueLoans, t.emptyOverdue, ["active"], false, true),
                      loanList("review", t.awaitingReview, t.emptyReview, ["requested"]),
                      loanList("approved", t.upcomingHandovers, t.emptyApproved, ["approved"]),
                      loanList("loan-queue", t.activeLoans, t.emptyActive, ["active"]),
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "stock",
            title: t.inventory,
            navigation: { visible: true, icon: "package" },
            parameters: {},
            rows: [
              {
                id: "stock",
                columns: [{ id: "content", span: 12, blocks: [{ id: "help", type: "markdown" as const, markdown: t.browseStock }, stock] }],
              },
            ],
          },
          {
            id: "kits",
            title: t.kits,
            navigation: { visible: true, icon: "box" },
            parameters: {},
            rows: [
              {
                id: "kits",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown" as const, markdown: t.kitCatalogHelp },
                      {
                        id: "create",
                        type: "form" as const,
                        formId: form("kit"),
                        fixedValues: {},
                        presentation: { kind: "dialog" as const, label: t.addKit, icon: "plus" },
                        onSuccessNavigate: {
                          kind: "navigate" as const,
                          pageId: "kit",
                          params: { kit_id: { source: "RESULT" as const, path: "recordId" as const } },
                        },
                      },
                      {
                        id: "kits",
                        type: "records" as const,
                        title: t.kits,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("kits"),
                            "\nselect ",
                            field("kits.name"),
                            ", ",
                            field("kits.status"),
                            ", ",
                            field("kits.requestable"),
                            ", ",
                            field("kits.items"),
                          ),
                        },
                        display: {
                          kind: "table" as const,
                          columnIds: [],
                          mobile: { titleColumnId: t.name, detailColumnIds: [t.status, t.requestable, t.items] },
                        },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate" as const,
                          history: "push" as const,
                          pageId: "kit",
                          params: { kit_id: { source: "ROW" as const, path: "id" as const } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "kit",
            title: t.kitDetails,
            navigation: { visible: false },
            parameters: { kit_id: { type: "record" as const, tableId: table("kits"), required: true as const } },
            record: { tableId: table("kits"), id: { source: "PARAMS" as const, path: "kit_id" as const } },
            rows: [
              {
                id: "kit",
                columns: [
                  {
                    id: "content",
                    span: 8,
                    blocks: [
                      {
                        id: "identity",
                        type: "record" as const,
                        heading: { fieldId: field("kits.name") },
                        layout: "rows" as const,
                        fieldIds: [
                          field("kits.name"),
                          field("kits.items"),
                          field("kits.status"),
                          field("kits.requestable"),
                          field("kits.description"),
                        ],
                        editableFieldIds: [],
                      },
                      {
                        id: "edit",
                        type: "form" as const,
                        formId: form("kit"),
                        mode: "edit",
                        fixedValues: {},
                        presentation: { kind: "dialog" as const, label: t.editKit, icon: "pencil", variant: "secondary" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "returns",
            title: t.returns,
            navigation: { visible: true, icon: "scan" },
            parameters: {},
            rows: [
              {
                id: "returns",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown" as const, markdown: t.returnHelp },
                      {
                        id: "return-item",
                        type: "scanner" as const,
                        title: t.markLoanItemReturned,
                        launcherId: launcher("return_loan_item_scanner"),
                      },
                      {
                        id: "report-defect",
                        type: "scanner" as const,
                        title: t.reportDamagedItem,
                        launcherId: launcher("report_item_defect_scanner"),
                        disclosure: { label: t.reportDamagedItem },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "archive",
            title: t.loanArchive,
            navigation: { visible: true, icon: "archive" },
            parameters: {},
            rows: [
              {
                id: "archive",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [loanList("archive", t.loanArchive, t.emptyArchive, ["returned", "cancelled", "rejected"])],
                  },
                ],
              },
            ],
          },
          {
            id: "loan",
            title: t.loanAdministration,
            navigation: { visible: false },
            parameters: loanParams,
            record: loanRecord,
            rows: [
              {
                id: "identity",
                columns: [
                  { id: "content", span: 8, blocks: [identity, ...statusHelp(true)] },
                  { id: "schedule", span: 4, blocks: [loanDates] },
                ],
              },
              {
                id: "next-actions",
                columns: [
                  {
                    id: "content",
                    span: 12,
                    blocks: [
                      {
                        id: "edit",
                        type: "form" as const,
                        formId: form("edit_loan"),
                        mode: "edit",
                        fixedValues: {},
                        presentation: { kind: "dialog" as const, label: t.editLoan, icon: "pencil", variant: "secondary" },
                        availableWhen: loanWhen(["requested"]),
                      },
                      {
                        id: "actions",
                        type: "actions" as const,
                        actions: [
                          {
                            id: "reject",
                            label: t.rejectLoan,
                            variant: "secondary",
                            kind: "workflow" as const,
                            launcherId: launcher("reject_loan"),
                            inputs: { loan: { source: "RECORD" as const, path: "id" as const } },
                            prompt: { inputs: ["reason"], description: t.rejectConfirm, successMessage: t.loanRejected },
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("loans"),
                                "\nwhere record.id = @params.loan_id and oneof(",
                                field("loans.status"),
                                ", 'requested', 'approved') and ",
                                field("loans.agreement_sent"),
                                " != 'processing'\nlimit 1",
                              ),
                            },
                          },
                          {
                            id: "approve",
                            label: t.approveLoan,
                            icon: "check",
                            kind: "workflow" as const,
                            launcherId: launcher("approve_loan_custom_app"),
                            inputs: { loan: { source: "RECORD" as const, path: "id" as const } },
                            confirm: t.approveLoanConfirm,
                            availableWhen: loanWhen(["requested"]),
                          },
                          {
                            id: "send-agreement",
                            label: t.sendAgreementAndStartLoan,
                            variant: "secondary",
                            icon: "mail",
                            kind: "workflow" as const,
                            launcherId: launcher("send_loan_agreement_custom_app"),
                            inputs: { loan: { source: "RECORD" as const, path: "id" as const } },
                            confirm: t.sendAgreementConfirm,
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("loans"),
                                "\nwhere record.id = @params.loan_id and oneof(",
                                field("loans.status"),
                                ", 'approved', 'active') and ",
                                field("loans.agreement_sent"),
                                " = 'ready'\nlimit 1",
                              ),
                            },
                          },
                          {
                            id: "close-loan",
                            label: t.closeLoan,
                            kind: "workflow" as const,
                            launcherId: launcher("close_loan"),
                            inputs: { loan: { source: "RECORD" as const, path: "id" as const } },
                            availableWhen: loanWhen(["active"]),
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                id: "work",
                columns: [
                  {
                    id: "positions",
                    span: 8,
                    blocks: [
                      requestedEquipment,
                      requestedKitContents,
                      {
                        id: "loan-positions",
                        type: "records" as const,
                        title: t.allocatedEquipment,
                        emptyText: t.emptyPositions,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("loan_positions"),
                            "\nwhere ",
                            field("loan_positions.loan"),
                            " = @params.loan_id\nselect ",
                            field("loan_positions.position_no"),
                            ", ",
                            field("loan_positions.item"),
                            ", ",
                            field("loan_positions.status"),
                            ", ",
                            field("loan_positions.condition"),
                          ),
                        },
                        display: {
                          kind: "table" as const,
                          columnIds: [],
                          mobile: { titleColumnId: t.positionItem, detailColumnIds: [t.positionNumber, t.status, t.returnedCondition] },
                        },
                        searchable: false,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate" as const,
                          history: "push" as const,
                          pageId: "position",
                          params: { position_id: { source: "ROW" as const, path: "id" as const } },
                        },
                      },
                      {
                        id: "add-position",
                        type: "records" as const,
                        title: t.addPosition,
                        emptyText: t.noAvailableEquipment,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("items"),
                            "\nwhere ",
                            field("items.status"),
                            " = 'available'\nselect ",
                            field("items.name"),
                            ", ",
                            field("items.asset_id"),
                            ", ",
                            field("items.location"),
                          ),
                        },
                        display: {
                          kind: "table" as const,
                          columnIds: [],
                          mobile: { titleColumnId: t.name, detailColumnIds: [t.assetId, t.location] },
                        },
                        searchable: true,
                        pageSize: 10,
                        availableWhen: loanWhen(["requested"]),
                        rowActions: [
                          {
                            id: "add",
                            kind: "workflow" as const,
                            label: t.addPosition,
                            launcherId: launcher("add_position"),
                            inputs: {
                              loan: { source: "RECORD" as const, path: "id" as const },
                              item: { source: "ROW" as const, path: "id" as const },
                            },
                            showLabel: true,
                          },
                        ],
                      },
                    ],
                  },
                  {
                    id: "context",
                    span: 4,
                    blocks: [
                      {
                        id: "details",
                        type: "record" as const,
                        title: t.deskContact,
                        layout: "rows" as const,
                        fieldIds: [field("loans.requester_name"), field("loans.requester_email"), field("loans.organization")],
                        editableFieldIds: [field("loans.requester_name"), field("loans.requester_email"), field("loans.organization")],
                      },
                      {
                        id: "checks",
                        type: "record",
                        title: t.loanSchedule,
                        layout: "rows",
                        fieldIds: [field("loans.availability_confirmed"), field("loans.agreement_sent")],
                        editableFieldIds: [],
                        disclosure: { label: t.loanSchedule },
                      },
                      loanDocuments(true),
                      {
                        id: "notes",
                        type: "record" as const,
                        fieldIds: [field("loans.notes")],
                        editableFieldIds: [field("loans.notes")],
                        disclosure: { label: t.adminNotes },
                      },
                    ],
                  },
                ],
              },
              {
                id: "updates",
                columns: [
                  { id: "content", span: 12, blocks: [{ id: "comments", type: "comments" as const, title: t.loanNotesAndUpdates }] },
                ],
              },
            ],
          },
          {
            id: "position",
            title: t.positionDetails,
            navigation: { visible: false },
            parameters: { position_id: { type: "record" as const, tableId: table("loan_positions"), required: true as const } },
            record: { tableId: table("loan_positions"), id: { source: "PARAMS" as const, path: "position_id" as const } },
            rows: [
              {
                id: "position",
                columns: [
                  {
                    id: "content",
                    span: 8,
                    blocks: [
                      {
                        id: "identity",
                        type: "record" as const,
                        heading: { fieldId: field("loan_positions.position_no") },
                        layout: "rows" as const,
                        fieldIds: [
                          field("loan_positions.position_no"),
                          field("loan_positions.item"),
                          field("loan_positions.loan"),
                          field("loan_positions.status"),
                          field("loan_positions.issued_at"),
                          field("loan_positions.returned_at"),
                          field("loan_positions.condition"),
                        ],
                        editableFieldIds: [],
                      },
                      { id: "help", type: "markdown" as const, markdown: t.positionHelp },
                      {
                        id: "actions",
                        type: "actions" as const,
                        actions: [
                          {
                            id: "cancel-position",
                            kind: "workflow",
                            label: t.cancelPosition,
                            variant: "secondary",
                            launcherId: launcher("cancel_position"),
                            inputs: { position: { source: "RECORD", path: "id" } },
                            confirm: t.cancelPositionHelp,
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("loan_positions"),
                                "\nwhere record.id = @params.position_id and ",
                                field("loan_positions.status"),
                                " = 'planned'\nlimit 1",
                              ),
                            },
                          },
                          {
                            id: "issue",
                            kind: "workflow" as const,
                            label: t.issuePosition,
                            launcherId: launcher("issue_position"),
                            inputs: { position: { source: "RECORD" as const, path: "id" as const } },
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("loan_positions"),
                                " as position\njoin table ",
                                table("loans"),
                                " as loan on ",
                                field("loan_positions.loan"),
                                " = loan.id\nwhere record.id = @params.position_id and ",
                                field("loan_positions.status"),
                                " = 'planned' and oneof(loan.",
                                field("loans.status"),
                                ", 'approved', 'active')\nlimit 1",
                              ),
                            },
                          },
                          {
                            id: "item",
                            kind: "navigate" as const,
                            history: "push",
                            variant: "secondary",
                            label: t.openItem,
                            pageId: "item",
                            params: {
                              item_id: { source: "RECORD" as const, path: "relation" as const, fieldId: field("loan_positions.item") },
                            },
                          },
                          {
                            id: "loan",
                            kind: "navigate" as const,
                            history: "push",
                            variant: "secondary",
                            label: t.loanDetails,
                            pageId: "loan",
                            params: {
                              loan_id: { source: "RECORD" as const, path: "relation" as const, fieldId: field("loan_positions.loan") },
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
          {
            id: "item",
            title: t.equipmentDetails,
            navigation: { visible: false },
            parameters: { item_id: { type: "record" as const, tableId: table("items"), required: true as const } },
            record: { tableId: table("items"), id: { source: "PARAMS" as const, path: "item_id" as const } },
            rows: [
              {
                id: "item",
                columns: [
                  {
                    id: "content",
                    span: 8,
                    blocks: [
                      {
                        id: "identity",
                        type: "record" as const,
                        heading: { fieldId: field("items.name") },
                        layout: "compact" as const,
                        fieldIds: [
                          field("items.name"),
                          field("items.asset_id"),
                          field("items.status"),
                          field("items.condition"),
                          field("items.location"),
                        ],
                        editableFieldIds: [],
                        documents: { templateIds: [documentTemplate("asset_label")] },
                      },
                      {
                        id: "repair",
                        type: "actions",
                        actions: [
                          {
                            id: "repair",
                            kind: "workflow",
                            label: t.completeRepair,
                            icon: "check",
                            launcherId: launcher("complete_repair"),
                            inputs: { item: { source: "RECORD", path: "id" } },
                            confirm: t.completeRepairHelp,
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("items"),
                                "\nwhere record.id = @params.item_id and ",
                                field("items.status"),
                                " = 'maintenance' and ",
                                field("items.current_position"),
                                " = null\nlimit 1",
                              ),
                            },
                          },
                        ],
                      },
                      {
                        id: "return",
                        type: "actions" as const,
                        actions: [
                          {
                            id: "return",
                            kind: "workflow" as const,
                            label: t.markLoanItemReturned,
                            icon: "arrow-back",
                            launcherId: launcher("return_loan_item_custom_app"),
                            inputs: { item: { source: "RECORD" as const, path: "id" as const } },
                            prompt: {
                              inputs: ["condition"],
                              description: t.returnedConditionDescription,
                              successMessage: t.positionReturned,
                            },
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("items"),
                                "\nwhere record.id = @params.item_id and ",
                                field("items.current_position"),
                                " != null\nlimit 1",
                              ),
                            },
                          },
                        ],
                      },
                      {
                        id: "edit",
                        type: "form" as const,
                        formId: form("edit_item"),
                        mode: "edit",
                        fixedValues: {},
                        presentation: { kind: "dialog" as const, label: t.editItem, icon: "pencil", variant: "secondary" },
                      },
                      {
                        id: "details",
                        type: "record" as const,
                        layout: "rows" as const,
                        fieldIds: [
                          field("items.requestable"),
                          field("items.serial_no"),
                          field("items.category"),
                          field("items.files"),
                          field("items.notes"),
                        ],
                        editableFieldIds: [],
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
