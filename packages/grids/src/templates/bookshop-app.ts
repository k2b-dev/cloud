import type { BookshopText } from "./bookshop";
import { documentTemplate, field, fieldKey, form, formula, type GridTemplate, launcher, table } from "./types";

/** One staff workspace: fulfillment first, supporting catalog and sales separately. */
export const bookshopApp = (t: BookshopText): NonNullable<GridTemplate["customApps"]> => {
  const orderNavigation = {
    kind: "navigate" as const,
    history: "push" as const,
    pageId: "order",
    params: { order_id: { source: "ROW" as const, path: "id" as const } },
  };
  const createdOrderNavigation = {
    kind: "navigate" as const,
    pageId: "order",
    params: { order_id: { source: "RESULT" as const, path: "recordId" as const } },
  };
  const back = (pageId: string, label: string) => ({
    id: "back",
    type: "actions" as const,
    actions: [{ id: "back", kind: "navigate" as const, history: "push" as const, pageId, params: {}, label, icon: "arrow-left" }],
  });
  const orderQuery = (where = "", customer = false) =>
    formula(
      "from table ",
      table("orders"),
      "\nselect ",
      field("orders.order_no"),
      ", ",
      field("orders.customer"),
      ", ",
      field("orders.ordered_at"),
      ", ",
      field("orders.status"),
      ", ",
      field("orders.invoice_sent"),
      ...(customer
        ? ["\nwhere ", field("orders.customer"), " = @params.customer_id"]
        : where
          ? ["\nwhere ", field("orders.status"), where]
          : []),
      "\nsort ",
      field("orders.ordered_at"),
      " desc",
    );
  const orders = (id: string, title: string, where = "", customer = false) => ({
    id,
    type: "records" as const,
    title,
    emptyText: t.noOrders,
    source: { kind: "gql" as const, query: orderQuery(where, customer) },
    display: {
      kind: "table" as const,
      columnIds: [],
      relativeDateColumnIds: [t.orderedAt],
      mobile: { titleColumnId: t.orderNumber, detailColumnIds: [t.customer, t.status, t.invoiceSent] },
    },
    searchable: true,
    pageSize: 25,
    rowNavigate: orderNavigation,
  });
  const ready = (ready: boolean) => ({
    query: formula(
      "from table ",
      table("orders"),
      "\nwhere record.id = @params.order_id and ",
      field("orders.invoice_sent"),
      ready ? " = 'ready'" : " != 'ready'",
      "\nlimit 1",
    ),
  });
  const editableOrder = {
    query: formula(
      "from table ",
      table("orders"),
      "\nwhere record.id = @params.order_id and ",
      field("orders.invoice_sent"),
      " = 'ready' and ",
      field("orders.status"),
      " != 'delivered'\nlimit 1",
    ),
  };
  const detail = (id: string, key: string) => ({
    parameters: { [id]: { type: "record" as const, tableId: table(key), required: true as const } },
    record: { tableId: table(key), id: { source: "PARAMS" as const, path: id } },
  });
  const lineWhen = (editable: boolean) => ({
    query: formula(
      "from table ",
      table("order_lines"),
      " as line\njoin table ",
      table("orders"),
      " as order on line.",
      field("order_lines.order"),
      " = order.id\nselect line.",
      field("order_lines.line_no"),
      "\nwhere record.id = @params.line_id and (order.",
      field("orders.invoice_sent"),
      editable ? " = 'ready' and order." : " != 'ready' or order.",
      field("orders.status"),
      editable ? " != 'delivered')\nlimit 1" : " = 'delivered')\nlimit 1",
    ),
  });
  const editableLine = lineWhen(true);
  const fulfillmentWhen = (status: "new" | "shipped" | "delivered") => ({
    query: formula(
      "from table ",
      table("orders"),
      "\nwhere record.id = @params.order_id and ",
      field("orders.status"),
      ` = '${status}'\nlimit 1`,
    ),
  });
  const fulfillmentAction = (id: string, label: string, icon: string, confirm: string, variant: "primary" | "secondary") => ({
    id: id.replaceAll("_", "-"),
    kind: "workflow" as const,
    label,
    icon,
    variant,
    launcherId: launcher(id),
    inputs: { order: { source: "RECORD" as const, path: "id" as const } },
    confirm,
    ...(id !== "reopen_order"
      ? {
          availableWhen: {
            query: formula("from table ", table("order_lines"), "\nwhere ", field("order_lines.order"), " = @params.order_id\nlimit 1"),
          },
        }
      : {}),
  });
  return [
    {
      key: "sales",
      definition: {
        schemaVersion: 5,
        kind: "grids.custom-app",
        name: t.templateName,
        icon: "books",
        startPageId: "overview",
        sidebar: {
          actions: [
            {
              id: "new-order",
              kind: "form",
              label: t.newOrder,
              icon: "plus",
              tone: "success",
              formId: form("new_order"),
              fixedValues: {},
              onSuccessNavigate: createdOrderNavigation,
            },
          ],
        },
        pages: [
          {
            id: "overview",
            title: t.workbench,
            navigation: { visible: true, icon: "shopping-cart" },
            parameters: {},
            rows: [
              {
                id: "orders",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [{ id: "help", type: "markdown", markdown: t.workbenchHelp }, orders("open", t.orders, " != 'delivered'")],
                  },
                ],
              },
            ],
          },
          {
            id: "completed",
            title: t.archive,
            navigation: { visible: true, icon: "package" },
            parameters: {},
            rows: [
              { id: "orders", columns: [{ id: "main", span: 12, blocks: [orders("completed", t.completedOrders, " = 'delivered'")] }] },
            ],
          },
          {
            id: "order",
            title: t.order,
            navigation: { visible: false },
            ...detail("order_id", "orders"),
            rows: [
              {
                id: "identity",
                columns: [
                  {
                    id: "main",
                    span: 8,
                    blocks: [
                      back("overview", t.backOrders),
                      {
                        id: "identity",
                        type: "record",
                        layout: "compact",
                        fieldIds: [field("orders.order_no"), field("orders.customer"), field("orders.status"), field("orders.ordered_at")],
                        relativeDates: [field("orders.ordered_at")],
                        editableFieldIds: [],
                        heading: { fieldId: field("orders.order_no") },
                        documents: { templateIds: [documentTemplate("order_invoice")] },
                      },
                      {
                        id: "edit-order",
                        type: "form",
                        formId: form("edit_order"),
                        mode: "edit",
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.editOrder, icon: "pencil" },
                        availableWhen: editableOrder,
                      },
                    ],
                  },
                  {
                    id: "next-step",
                    span: 4,
                    blocks: [
                      {
                        id: "prepare-help",
                        type: "markdown",
                        title: t.nextStep,
                        markdown: `**${t.prepareOrder}**\n\n${t.prepareOrderHelp}`,
                        availableWhen: fulfillmentWhen("new"),
                      },
                      {
                        id: "prepare-actions",
                        type: "actions",
                        actions: [
                          fulfillmentAction("mark_order_shipped", t.markShipped, "truck-delivery", t.shippedConfirm, "primary"),
                          fulfillmentAction("complete_order", t.confirmHandover, "check", t.handoverConfirm, "secondary"),
                        ],
                        availableWhen: fulfillmentWhen("new"),
                      },
                      {
                        id: "shipped-help",
                        type: "markdown",
                        title: t.nextStep,
                        markdown: `**${t.onTheWay}**\n\n${t.onTheWayHelp}`,
                        availableWhen: fulfillmentWhen("shipped"),
                      },
                      {
                        id: "shipped-actions",
                        type: "actions",
                        actions: [
                          fulfillmentAction("complete_order", t.confirmDelivery, "check", t.handoverConfirm, "primary"),
                          fulfillmentAction("reopen_order", t.reopenOrder, "arrow-back-up", t.reopenConfirm, "secondary"),
                        ],
                        availableWhen: fulfillmentWhen("shipped"),
                      },
                      {
                        id: "completed-help",
                        type: "markdown",
                        markdown: `:::success ${t.fulfillmentDone}\n${t.fulfillmentDoneHelp}\n:::`,
                        availableWhen: fulfillmentWhen("delivered"),
                      },
                      {
                        id: "completed-actions",
                        type: "actions",
                        actions: [fulfillmentAction("reopen_order", t.reopenOrder, "arrow-back-up", t.reopenConfirm, "secondary")],
                        availableWhen: fulfillmentWhen("delivered"),
                      },
                    ],
                  },
                ],
              },
              {
                id: "work",
                columns: [
                  {
                    id: "lines",
                    span: 8,
                    blocks: [
                      {
                        id: "lines",
                        type: "records",
                        title: t.orderLines,
                        emptyText: t.noLines,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("order_lines"),
                            "\nselect ",
                            field("order_lines.book"),
                            ", ",
                            field("order_lines.quantity"),
                            ", ",
                            field("order_lines.unit_price"),
                            ", ",
                            field("order_lines.line_total"),
                            "\nwhere ",
                            field("order_lines.order"),
                            " = @params.order_id\nsort ",
                            field("order_lines.line_no"),
                            " asc",
                          ),
                        },
                        display: {
                          kind: "table",
                          columnIds: [],
                          mobile: { titleColumnId: t.book, detailColumnIds: [t.quantity, t.unitPrice, t.lineTotal] },
                        },
                        searchable: false,
                        pageSize: 25,
                        rowActions: [
                          {
                            id: "remove",
                            kind: "workflow",
                            label: t.removeLine,
                            icon: "trash",
                            showLabel: false,
                            variant: "danger",
                            launcherId: launcher("remove_order_line"),
                            inputs: { line: { source: "ROW", path: "id" } },
                            confirm: t.removeLineConfirm,
                            availableWhen: editableOrder,
                          },
                        ],
                        rowNavigate: {
                          kind: "navigate",
                          history: "push",
                          pageId: "line",
                          params: {
                            line_id: { source: "ROW", path: "id" },
                          },
                        },
                      },
                      {
                        id: "add-line",
                        type: "form",
                        formId: form("add_order_line"),
                        fixedValues: { [fieldKey("order_lines.order")]: { source: "RECORD", path: "id" } },
                        presentation: { kind: "dialog", label: t.addOrderLine, icon: "plus", variant: "primary" },
                        availableWhen: editableOrder,
                      },
                      {
                        id: "value",
                        type: "metrics",
                        title: t.orderValue,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("order_lines"),
                            "\nwhere ",
                            field("order_lines.order"),
                            " = @params.order_id\naggregate sum(",
                            field("order_lines.line_total"),
                            ") as ",
                            t.total,
                          ),
                        },
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" },
                      },
                      { id: "value-help", type: "markdown", markdown: t.orderValueHelp },
                    ],
                  },
                  {
                    id: "context",
                    span: 4,
                    blocks: [
                      {
                        id: "invoice-help",
                        type: "markdown",
                        title: t.reviewInvoice,
                        markdown: t.invoiceHelp,
                        availableWhen: ready(true),
                      },
                      {
                        id: "sample-email",
                        type: "markdown",
                        markdown: `:::info\n${t.sampleHelp}\n:::`,
                        availableWhen: {
                          query: formula(
                            "from table ",
                            table("orders"),
                            "\nwhere record.id = @params.order_id and ENDSWITH(",
                            field("orders.customer_email"),
                            ", '.test')\nlimit 1",
                          ),
                        },
                      },
                      {
                        id: "invoice-status",
                        type: "record",
                        title: t.invoiceSent,
                        layout: "rows",
                        fieldIds: [field("orders.customer_email"), field("orders.invoice_sent")],
                        editableFieldIds: [],
                        availableWhen: ready(true),
                      },
                      {
                        id: "send",
                        type: "actions",
                        actions: [
                          {
                            id: "send-invoice",
                            kind: "workflow",
                            label: t.sendInvoice,
                            icon: "mail",
                            variant: "secondary",
                            launcherId: launcher("send_order_invoice_custom_app"),
                            inputs: { order: { source: "RECORD", path: "id" } },
                            confirm: t.invoiceConfirm,
                            background: {
                              acceptedMessage: t.invoiceAccepted,
                              documentBlockId: "identity",
                              documentTemplateId: documentTemplate("order_invoice"),
                            },
                            availableWhen: ready(true),
                          },
                        ],
                      },
                      {
                        id: "delivery",
                        type: "record",
                        title: t.invoiceSent,
                        layout: "rows",
                        fieldIds: [field("orders.invoice_sent")],
                        editableFieldIds: [],
                        availableWhen: ready(false),
                      },
                      { id: "delivery-help", type: "markdown", markdown: t.deliveryHelp, availableWhen: ready(false) },
                      {
                        id: "customer",
                        type: "actions",
                        actions: [
                          {
                            id: "customer",
                            kind: "navigate",
                            history: "push",
                            pageId: "customer",
                            params: { customer_id: { source: "RECORD", path: "relation", fieldId: field("orders.customer") } },
                            label: t.contact,
                            icon: "user",
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
            id: "line",
            title: t.orderLines,
            navigation: { visible: false },
            ...detail("line_id", "order_lines"),
            rows: [
              {
                id: "line",
                columns: [
                  {
                    id: "main",
                    span: 8,
                    blocks: [
                      {
                        id: "back",
                        type: "actions",
                        actions: [
                          {
                            id: "back",
                            kind: "navigate",
                            history: "push",
                            pageId: "order",
                            params: { order_id: { source: "RECORD", path: "relation", fieldId: field("order_lines.order") } },
                            label: t.backOrder,
                            icon: "arrow-left",
                          },
                        ],
                      },
                      {
                        id: "line",
                        type: "record",
                        layout: "compact",
                        heading: { fieldId: field("order_lines.book") },
                        fieldIds: [field("order_lines.book"), field("order_lines.order"), field("order_lines.line_total")],
                        editableFieldIds: [],
                      },
                      {
                        id: "line-prices",
                        type: "record",
                        layout: "rows",
                        fieldIds: [field("order_lines.quantity"), field("order_lines.unit_price")],
                        editableFieldIds: [],
                        availableWhen: lineWhen(false),
                      },
                      {
                        id: "edit",
                        type: "form",
                        mode: "edit",
                        formId: form("edit_order_line"),
                        fixedValues: {},
                        availableWhen: editableLine,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "catalog",
            title: t.catalog,
            navigation: { visible: true, icon: "books" },
            parameters: {},
            rows: [
              {
                id: "catalog",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown", markdown: t.catalogHelp },
                      {
                        id: "create",
                        type: "form",
                        formId: form("add_book"),
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.addBook, icon: "plus", variant: "primary" },
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "book",
                          params: { book_id: { source: "RESULT", path: "recordId" } },
                        },
                      },
                      {
                        id: "books",
                        type: "records",
                        title: t.books,
                        emptyText: t.noBooks,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("books"),
                            "\nselect ",
                            field("books.title"),
                            ", ",
                            field("books.author"),
                            ", ",
                            field("books.genre"),
                            ", ",
                            field("books.price"),
                            ", ",
                            field("books.in_stock"),
                            "\nsort ",
                            field("books.title"),
                            " asc",
                          ),
                        },
                        display: {
                          kind: "table",
                          columnIds: [],
                          mobile: { titleColumnId: t.title, detailColumnIds: [t.author, t.price, t.inStock] },
                        },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate",
                          history: "push",
                          pageId: "book",
                          params: { book_id: { source: "ROW", path: "id" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "book",
            title: t.book,
            navigation: { visible: false },
            ...detail("book_id", "books"),
            rows: [
              {
                id: "book",
                columns: [
                  {
                    id: "main",
                    span: 8,
                    blocks: [
                      back("catalog", t.backCatalog),
                      {
                        id: "book",
                        type: "record",
                        layout: "rows",
                        heading: { fieldId: field("books.title") },
                        fieldIds: [
                          field("books.title"),
                          field("books.author"),
                          field("books.genre"),
                          field("books.price"),
                          field("books.in_stock"),
                          field("books.isbn"),
                        ],
                        editableFieldIds: [],
                      },
                      {
                        id: "edit",
                        type: "form",
                        mode: "edit",
                        formId: form("add_book"),
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.edit, icon: "pencil" },
                      },
                      {
                        id: "details",
                        type: "record",
                        layout: "rows",
                        disclosure: { label: t.optionalDetails },
                        fieldIds: [field("books.description"), field("books.pages"), field("books.published"), field("books.tags")],
                        editableFieldIds: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "customers",
            title: t.customers,
            navigation: { visible: true, icon: "users" },
            parameters: {},
            rows: [
              {
                id: "customers",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown", markdown: t.customerPageHelp },
                      {
                        id: "create",
                        type: "form",
                        formId: form("customer"),
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.addCustomer, icon: "plus", variant: "primary" },
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "customer",
                          params: { customer_id: { source: "RESULT", path: "recordId" } },
                        },
                      },
                      {
                        id: "customers",
                        type: "records",
                        title: t.customerDirectory,
                        emptyText: t.noCustomers,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("customers"),
                            "\nselect ",
                            field("customers.name"),
                            ", ",
                            field("customers.email"),
                            ", ",
                            field("customers.phone"),
                            "\nsort ",
                            field("customers.name"),
                            " asc",
                          ),
                        },
                        display: { kind: "table", columnIds: [], mobile: { titleColumnId: t.name, detailColumnIds: [t.email, t.phone] } },
                        searchable: true,
                        pageSize: 25,
                        rowNavigate: {
                          kind: "navigate",
                          history: "push",
                          pageId: "customer",
                          params: { customer_id: { source: "ROW", path: "id" } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "customer",
            title: t.customer,
            navigation: { visible: false },
            ...detail("customer_id", "customers"),
            rows: [
              {
                id: "customer",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      back("customers", t.backCustomers),
                      {
                        id: "customer",
                        type: "record",
                        layout: "compact",
                        heading: { fieldId: field("customers.name") },
                        fieldIds: [field("customers.name"), field("customers.email"), field("customers.phone")],
                        editableFieldIds: [],
                      },
                      {
                        id: "edit",
                        type: "form",
                        mode: "edit",
                        formId: form("customer"),
                        fixedValues: {},
                        presentation: { kind: "dialog", label: t.edit, icon: "pencil" },
                      },
                      {
                        id: "sample",
                        type: "markdown",
                        markdown: `:::info\n${t.sampleHelp}\n:::`,
                        availableWhen: {
                          query: formula(
                            "from table ",
                            table("customers"),
                            "\nwhere record.id = @params.customer_id and ENDSWITH(",
                            field("customers.email"),
                            ", '.test')\nlimit 1",
                          ),
                        },
                      },
                      orders("orders", t.orders, "", true),
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "insights",
            title: t.insights,
            navigation: { visible: true, icon: "chart-line" },
            parameters: {},
            rows: [
              {
                id: "sales",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "help", type: "markdown", markdown: `:::info\n${t.salesHelp}\n:::` },
                      {
                        id: "value",
                        type: "metrics",
                        title: t.orderValue,
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("order_lines"),
                            "\naggregate sum(",
                            field("order_lines.line_total"),
                            ") as ",
                            t.total,
                          ),
                        },
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" },
                      },
                      {
                        id: "monthly",
                        type: "chart",
                        title: t.monthlyRevenue,
                        chartType: "line",
                        source: {
                          kind: "gql",
                          query: formula(
                            "from table ",
                            table("order_lines"),
                            " as line\njoin table ",
                            table("orders"),
                            " as order on line.",
                            field("order_lines.order"),
                            " = order.id\ngroup by order.",
                            field("orders.ordered_at"),
                            " by month\naggregate sum(line.",
                            field("order_lines.line_total"),
                            ") as ",
                            t.total,
                            "\nsort order.",
                            field("orders.ordered_at"),
                            " asc",
                          ),
                        },
                        valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" },
                        limit: 100,
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
