import type { InventoryText } from "./inventory";
import { documentTemplate, field, fieldKey, form, formula, type GridTemplate, launcher, table } from "./types";

/** Borrowers request kits; the desk owns individual handovers and returns. */
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
    fieldIds: [
      field("loans.loan_no"),
      field("loans.requester_name"),
      field("loans.status"),
      field("loans.start_date"),
      field("loans.due_date"),
    ],
    relativeDates: [field("loans.due_date")],
    editableFieldIds: [],
    documents: { templateIds: [documentTemplate("loan_agreement")], preview: true },
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
                      {
                        id: "new-loan",
                        type: "actions" as const,
                        actions: [
                          {
                            id: "catalog",
                            kind: "navigate" as const,
                            history: "push",
                            label: t.newLoan,
                            variant: "primary",
                            icon: "plus",
                            pageId: "catalog",
                            params: {},
                          },
                        ],
                      },
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
                      {
                        id: "request",
                        type: "form" as const,
                        formId: form("request_loan"),
                        fixedValues: { [fieldKey("loans.kits")]: { source: "RECORD" as const, path: "id" as const } },
                        presentation: { kind: "dialog" as const, label: t.requestKitLoan, icon: "plus" },
                        onSuccessNavigate: navigateLoan,
                      },
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
                id: "detail",
                columns: [
                  {
                    id: "content",
                    span: 8,
                    blocks: [
                      { ...identity, documents: { templateIds: [documentTemplate("loan_agreement")] } },
                      {
                        id: "rejection",
                        type: "record" as const,
                        fieldIds: [field("loans.rejection_reason")],
                        editableFieldIds: [],
                        availableWhen: loanWhen(["rejected"]),
                      },
                      {
                        id: "request-help",
                        type: "markdown" as const,
                        markdown: t.requestedHelp,
                        availableWhen: loanWhen(["requested", "approved"]),
                      },
                      {
                        id: "details",
                        type: "record" as const,
                        layout: "rows" as const,
                        fieldIds: [
                          field("loans.kits"),
                          field("loans.purpose"),
                          field("loans.requester_email"),
                          field("loans.organization"),
                        ],
                        editableFieldIds: [],
                      },
                      {
                        id: "actions",
                        type: "actions" as const,
                        actions: [
                          {
                            id: "cancel",
                            label: t.cancelRequest,
                            variant: "secondary",
                            kind: "workflow" as const,
                            launcherId: launcher("cancel_loan_custom_app"),
                            inputs: { loan: { source: "RECORD" as const, path: "id" as const } },
                            confirm: t.cancelRequestConfirm,
                            availableWhen: loanWhen(["requested"]),
                          },
                        ],
                      },
                      { id: "comments", type: "comments" as const, title: t.questionsAndUpdates },
                    ],
                  },
                ],
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
              { id: "identity", columns: [{ id: "content", span: 12, blocks: [identity] }] },
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
                      { id: "prepare-help", type: "markdown" as const, markdown: t.prepareHelp, availableWhen: loanWhen(["requested"]) },
                      {
                        id: "active-help",
                        type: "markdown" as const,
                        markdown: t.activeHelp,
                        availableWhen: loanWhen(["approved", "active"]),
                      },
                      {
                        id: "loan-positions",
                        type: "records" as const,
                        title: t.loanPositions,
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
                        layout: "rows" as const,
                        fieldIds: [
                          field("loans.kits"),
                          field("loans.purpose"),
                          field("loans.requester_name"),
                          field("loans.requester_email"),
                          field("loans.organization"),
                          field("loans.availability_confirmed"),
                          field("loans.agreement_sent"),
                        ],
                        editableFieldIds: [field("loans.requester_name"), field("loans.requester_email"), field("loans.organization")],
                      },
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
                        fieldIds: [field("items.serial_no"), field("items.category"), field("items.files"), field("items.notes")],
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
