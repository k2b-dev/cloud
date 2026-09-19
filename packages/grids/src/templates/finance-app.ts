import type { FinanceText } from "./finance";
import { documentTemplate, field, form, formula, type GridTemplate, launcher, table, view, viewColumns } from "./types";

const thisMonth = (key: string) => ["YEAR(", field(key), ") = YEAR(TODAY()) and MONTH(", field(key), ") = MONTH(TODAY())"];
const euros = { style: "number" as const, decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" as const };

export const financeBudgetViews = (t: FinanceText): NonNullable<GridTemplate["views"]> => [
  {
    key: "current_spending",
    table: "transactions",
    name: t.budgetSpendTotals,
    source: formula(
      "from table ",
      table("transactions"),
      "\nwhere ",
      field("transactions.type"),
      " = 'expense'\ngroup by ",
      field("transactions.category"),
      "\naggregate sum(formula(IF(",
      ...thisMonth("transactions.date"),
      ", ",
      field("transactions.amount"),
      ", 0))) as spent",
    ),
  },
  {
    key: "current_budget_limits",
    table: "budgets",
    name: t.budgetLimitTotals,
    source: formula(
      "from table ",
      table("budgets"),
      "\ngroup by ",
      field("budgets.category"),
      "\naggregate sum(formula(IF(",
      ...thisMonth("budgets.month"),
      ", ",
      field("budgets.limit"),
      ", 0))) as limit_total, sum(formula(IF(",
      ...thisMonth("budgets.month"),
      ", 1, 0))) as budget_count",
    ),
  },
];

export const financeApp = (t: FinanceText): NonNullable<GridTemplate["customApps"]> => {
  type App = NonNullable<GridTemplate["customApps"]>[number]["definition"];
  type Block = App["pages"][number]["rows"][number]["columns"][number]["blocks"][number];
  const row = (id: string, blocks: Block[]) => ({ id, columns: [{ id: `${id}-column`, span: 12, blocks }] });
  const dialog = (id: string, formKey: string, label: string, edit = false): Block => ({
    id,
    type: "form",
    formId: form(formKey),
    fixedValues: {},
    ...(edit ? { mode: "edit" } : {}),
    presentation: {
      kind: "dialog",
      label,
      icon: edit ? "pencil" : "plus",
      variant: edit || formKey === "log_income" ? "secondary" : "primary",
    },
  });
  const back = (pageId: string, label: string): Block => ({
    id: "back",
    type: "actions",
    actions: [{ id: "back", kind: "navigate", history: "push", pageId, params: {}, label, icon: "arrow-left", variant: "secondary" }],
  });
  const transactionRows = (id: string, pending: boolean, context?: "accounts" | "categories"): Block => ({
    id,
    type: "records",
    title: pending ? t.review : t.activity,
    emptyText: pending ? t.noReview : t.noTransactions,
    source: {
      kind: "gql",
      query: formula(
        "from table ",
        table("transactions"),
        "\nselect ",
        field("transactions.merchant"),
        ", ",
        field("transactions.date"),
        ", ",
        field("transactions.account"),
        ", ",
        field("transactions.category"),
        ", ",
        field("transactions.type"),
        ", ",
        field("transactions.amount"),
        ", ",
        field("transactions.cleared"),
        ...(pending ? ["\nwhere ", field("transactions.cleared"), " = false"] : []),
        ...(context === "accounts" || context === "categories"
          ? ["\nwhere ", field(context === "accounts" ? "transactions.account" : "transactions.category"), " = @params.item_id"]
          : []),
        "\nsort ",
        field("transactions.date"),
        " desc, record.createdAt desc",
      ),
    },
    display: {
      kind: "table",
      columnIds: [],
      relativeDateColumnIds: [t.date],
      mobile: { titleColumnId: t.merchant, detailColumnIds: [t.date, t.type, t.amount, t.cleared] },
    },
    searchable: true,
    pageSize: pending ? 10 : 25,
    rowNavigate: { kind: "navigate", history: "push", pageId: "transaction", params: { transaction_id: { source: "ROW", path: "id" } } },
  });
  const whenTransaction = (predicate: string, target?: string) => ({
    query: formula(
      "from table ",
      table("transactions"),
      "\nwhere record.id = @params.transaction_id",
      ...(target ? [" and ", field(target), predicate] : []),
      "\nlimit 1",
    ),
  });
  const budgetRows: Block = {
    id: "current-budgets",
    type: "records",
    title: t.currentBudgets,
    emptyText: t.noBudgets,
    source: {
      kind: "gql",
      query: formula(
        "from table ",
        table("categories"),
        " as category_row\nleft join view ",
        view("current_spending"),
        " as spending on spending.gk_0 = category_row.id\nleft join view ",
        view("current_budget_limits"),
        " as planned on planned.gk_0 = category_row.id\nselect ",
        field("categories.name"),
        ` as ${t.category}, formula(planned.limit_total) as ${t.budget}, formula(IF(ISBLANK(spending.spent), 0, spending.spent)) as ${t.spent}, formula(planned.limit_total - IF(ISBLANK(spending.spent), 0, spending.spent)) as ${t.remaining}\nwhere planned.budget_count > 0\nsort `,
        field("categories.name"),
        " asc",
      ),
    },
    display: { kind: "table", columnIds: [], mobile: { titleColumnId: t.category, detailColumnIds: [t.budget, t.spent, t.remaining] } },
    searchable: true,
    pageSize: 25,
    rowNavigate: { kind: "navigate", history: "push", pageId: "categories", params: { item_id: { source: "ROW", path: "id" } } },
  };
  return [
    {
      key: "overview",
      definition: {
        schemaVersion: 5,
        kind: "grids.custom-app",
        name: t.financeOverview,
        icon: "wallet",
        startPageId: "overview",
        sidebar: {
          actions: (["expense", "income"] as const).map((kind) => ({
            id: kind,
            kind: "form",
            label: kind === "expense" ? t.logExpense : t.logIncome,
            icon: kind === "expense" ? "minus" : "plus",
            tone: kind === "expense" ? "default" : "success",
            formId: form(`log_${kind}`),
            fixedValues: {},
            onSuccessNavigate: {
              kind: "navigate",
              pageId: "transaction",
              params: { transaction_id: { source: "RESULT", path: "recordId" } },
            },
          })),
        },
        pages: [
          {
            id: "overview",
            title: t.overview,
            navigation: { visible: true, icon: "layout-dashboard" },
            parameters: {},
            rows: [
              row("context", [{ id: "month-help", type: "markdown", markdown: t.overviewHelp }]),
              {
                id: "month-summary",
                columns: [
                  ...(["income", "expense"] as const).map((kind) => ({
                    id: kind,
                    span: 4,
                    blocks: [
                      {
                        id: kind === "income" ? "w-income" : "w-spend",
                        type: "metrics" as const,
                        title: kind === "income" ? t.monthlyIncome : t.monthlySpend,
                        valueFormat: euros,
                        source: {
                          kind: "gql" as const,
                          query: formula(
                            "from table ",
                            table("transactions"),
                            "\nwhere ",
                            field("transactions.type"),
                            ` = '${kind}' and `,
                            ...thisMonth("transactions.date"),
                            "\naggregate sum(",
                            field("transactions.amount"),
                            `) as ${t.metricTotal}`,
                          ),
                        },
                      },
                    ],
                  })),
                  {
                    id: "budget",
                    span: 4,
                    blocks: [
                      {
                        id: "w-budget",
                        type: "metrics",
                        title: t.budget,
                        valueFormat: euros,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("budgets"),
                            "\nwhere ",
                            ...thisMonth("budgets.month"),
                            "\naggregate sum(",
                            field("budgets.limit"),
                            `) as ${t.budget}`,
                          ),
                        },
                      },
                    ],
                  },
                ],
              },
              row("reconcile-help", [{ id: "help", type: "markdown", markdown: `:::info ${t.review}\n${t.reviewHelp}\n:::` }]),
              row("review", [transactionRows("pending", true)]),
              {
                id: "trends",
                columns: [
                  {
                    id: "categories",
                    span: 6,
                    blocks: [
                      {
                        id: "spending-categories",
                        type: "chart",
                        title: t.spendByCategory,
                        subtitle: t.overview,
                        chartType: "donut",
                        valueFormat: euros,
                        limit: 30,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("transactions"),
                            "\njoin table ",
                            table("categories"),
                            " as category on ",
                            field("transactions.category"),
                            " = category.id\nwhere ",
                            field("transactions.type"),
                            " = 'expense' and ",
                            ...thisMonth("transactions.date"),
                            "\ngroup by category.",
                            field("categories.name"),
                            "\naggregate sum(",
                            field("transactions.amount"),
                            `) as ${t.spend}\nsort ${t.spend} desc`,
                          ),
                        },
                      },
                    ],
                  },
                  {
                    id: "months",
                    span: 6,
                    blocks: [
                      {
                        id: "spending-months",
                        type: "chart",
                        title: t.monthlySpend,
                        chartType: "bar",
                        valueFormat: euros,
                        limit: 12,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("transactions"),
                            "\nwhere ",
                            field("transactions.type"),
                            " = 'expense' and ",
                            field("transactions.date"),
                            " >= DATEADD(DATEADD(TODAY(), 1 - DAY(TODAY()), 'days'), -11, 'months') and ",
                            field("transactions.date"),
                            " < DATEADD(DATEADD(TODAY(), 1 - DAY(TODAY()), 'days'), 1, 'months')\ngroup by ",
                            field("transactions.date"),
                            " by month\naggregate sum(",
                            field("transactions.amount"),
                            `) as ${t.spend}\nsort `,
                            field("transactions.date"),
                            " asc",
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
            id: "transactions",
            title: t.activity,
            navigation: { visible: true, icon: "arrows-exchange" },
            parameters: {},
            rows: [row("transactions", [transactionRows("all", false)])],
          },
          {
            id: "budgets",
            title: t.plan,
            navigation: { visible: true, icon: "target-arrow" },
            parameters: {},
            rows: [
              row("entry", [dialog("create-budget", "budget", t.newBudget)]),
              row("help", [{ id: "help", type: "markdown", markdown: `:::info ${t.plan}\n${t.budgetHelp}\n:::` }]),
              row("current", [budgetRows]),
              row("history", [
                {
                  id: "history",
                  type: "records",
                  title: t.budgetHistory,
                  source: { kind: "view", viewId: view("budgets") },
                  disclosure: { label: t.budgetHistory },
                  display: { kind: "table", columnIds: viewColumns("budgets") },
                  searchable: true,
                  pageSize: 10,
                  rowNavigate: {
                    kind: "navigate",
                    history: "push",
                    pageId: "budget",
                    params: { budget_id: { source: "ROW", path: "id" } },
                  },
                },
              ]),
            ],
          },
          {
            id: "transaction",
            title: t.transaction,
            navigation: { visible: false },
            parameters: { transaction_id: { type: "record", tableId: table("transactions"), required: true } },
            record: { tableId: table("transactions"), id: { source: "PARAMS", path: "transaction_id" } },
            rows: [
              row("navigation", [back("transactions", t.activity)]),
              row("identity", [
                {
                  id: "identity",
                  type: "record",
                  heading: { fieldId: field("transactions.merchant") },
                  layout: "compact",
                  fieldIds: [
                    field("transactions.merchant"),
                    field("transactions.transaction_ref"),
                    field("transactions.date"),
                    field("transactions.type"),
                    field("transactions.amount"),
                    field("transactions.cleared"),
                  ],
                  editableFieldIds: [field("transactions.cleared")],
                  relativeDates: [field("transactions.date")],
                },
              ]),
              {
                id: "context",
                columns: [
                  {
                    id: "main",
                    span: 8,
                    blocks: [
                      dialog("edit", "edit_transaction", t.editTransaction, true),
                      {
                        id: "details",
                        type: "record",
                        title: t.details,
                        layout: "rows",
                        fieldIds: [field("transactions.account"), field("transactions.category"), field("transactions.notes")],
                        editableFieldIds: [],
                      },
                      {
                        id: "reconcile",
                        type: "markdown",
                        markdown: `:::info ${t.review}\n${t.reviewHelp}\n:::`,
                        availableWhen: whenTransaction(" = false", "transactions.cleared"),
                      },
                    ],
                  },
                  {
                    id: "supporting",
                    span: 4,
                    blocks: [
                      {
                        id: "receipt-help",
                        type: "markdown",
                        markdown: `:::info ${t.viewSummary}\n${t.receiptHelp}\n:::`,
                        availableWhen: whenTransaction(" = 'expense'", "transactions.type"),
                      },
                      {
                        id: "documents",
                        type: "record",
                        layout: "rows",
                        fieldIds: [field("transactions.receipt_email"), field("transactions.receipt_sent")],
                        editableFieldIds: [field("transactions.receipt_email")],
                        documents: { templateIds: [documentTemplate("transaction_receipt")], preview: true },
                        availableWhen: whenTransaction(" = 'expense'", "transactions.type"),
                      },
                      {
                        id: "send",
                        type: "actions",
                        actions: [
                          {
                            id: "send",
                            kind: "workflow",
                            label: t.processReceipt,
                            icon: "mail",
                            variant: "secondary",
                            launcherId: launcher("send_receipt_custom_app"),
                            inputs: { transaction: { source: "RECORD", path: "id" } },
                            confirm: t.sendConfirm,
                            availableWhen: {
                              query: formula(
                                "from table ",
                                table("transactions"),
                                "\nwhere record.id = @params.transaction_id and ",
                                field("transactions.type"),
                                " = 'expense' and ",
                                field("transactions.receipt_sent"),
                                " = 'ready' and not ISBLANK(",
                                field("transactions.receipt_email"),
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
            ],
          },
          {
            id: "budget",
            title: t.editBudget,
            navigation: { visible: false },
            parameters: { budget_id: { type: "record", tableId: table("budgets"), required: true } },
            record: { tableId: table("budgets"), id: { source: "PARAMS", path: "budget_id" } },
            rows: [
              row("navigation", [back("budgets", t.plan)]),
              row("budget", [
                {
                  id: "budget",
                  type: "record",
                  title: t.budget,
                  layout: "compact",
                  fieldIds: [field("budgets.category"), field("budgets.month"), field("budgets.limit")],
                  editableFieldIds: [],
                },
                dialog("edit", "budget", t.editBudget, true),
              ]),
              row("activity", [
                {
                  id: "category",
                  type: "actions",
                  actions: [
                    {
                      id: "category",
                      kind: "navigate",
                      history: "push",
                      pageId: "categories",
                      label: t.categoryTransactions,
                      variant: "secondary",
                      icon: "arrows-exchange",
                      params: { item_id: { source: "RECORD", path: "relation", fieldId: field("budgets.category") } },
                    },
                  ],
                },
              ]),
            ],
          },
          {
            id: "setup",
            title: t.setup,
            navigation: { visible: true, icon: "settings" },
            parameters: {},
            rows: [
              row("help", [{ id: "help", type: "markdown", markdown: t.setupHelp }]),
              ...(["accounts", "categories"] as const).map((key) =>
                row(key, [
                  dialog(`create-${key}`, key, key === "accounts" ? t.newAccount : t.newCategory),
                  {
                    id: key,
                    type: "records",
                    title: key === "accounts" ? t.accounts : t.categories,
                    source: {
                      kind: "gql",
                      query: formula(
                        "from table ",
                        table(key),
                        "\nselect ",
                        field(`${key}.name`),
                        ", ",
                        field(`${key}.kind`),
                        ", ",
                        field(`${key}.${key === "accounts" ? "opening_balance" : "fixed"}`),
                        "\nsort ",
                        field(`${key}.name`),
                        " asc",
                      ),
                    },
                    display: {
                      kind: "table",
                      columnIds: [],
                      mobile: { titleColumnId: t.name, detailColumnIds: [t.kind, key === "accounts" ? t.openingBalance : t.fixed] },
                    },
                    searchable: true,
                    pageSize: 10,
                    rowNavigate: { kind: "navigate", history: "push", pageId: key, params: { item_id: { source: "ROW", path: "id" } } },
                  },
                ]),
              ),
            ],
          },
          ...(["accounts", "categories"] as const).map((key) => ({
            id: key,
            title: key === "accounts" ? t.editAccount : t.editCategory,
            navigation: { visible: false },
            parameters: { item_id: { type: "record" as const, tableId: table(key), required: true as const } },
            record: { tableId: table(key), id: { source: "PARAMS" as const, path: "item_id" } },
            rows: [
              row("navigation", [back("setup", t.setup)]),
              row("details", [
                {
                  id: "details",
                  type: "record",
                  layout: "compact",
                  heading: { fieldId: field(`${key}.name`) },
                  fieldIds: [
                    field(`${key}.name`),
                    field(`${key}.kind`),
                    field(`${key}.${key === "accounts" ? "opening_balance" : "fixed"}`),
                  ],
                  editableFieldIds: [],
                },
                dialog("edit", key, key === "accounts" ? t.editAccount : t.editCategory, true),
              ]),
              row("activity", [transactionRows("related-transactions", false, key)]),
            ],
          })),
        ],
      },
    },
  ];
};
