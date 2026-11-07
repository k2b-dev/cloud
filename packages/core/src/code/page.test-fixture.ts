/** One Code page with every block, as a workshop Code would return it. Checked by tests before use. */
export const codePageFixture = {
  version: 1,
  kind: "Page",
  title: "Workshop",
  follow: ["grids.record.changed"],
  children: [
    { kind: "Notice", tone: "warning", title: "Two items wait for a check", text: "Scan an item to open it." },
    { kind: "Text", text: "Everything the workshop handles today." },
    {
      kind: "Section",
      title: "Today",
      children: [
        {
          kind: "Chart",
          description: {
            kind: "bar",
            title: "Items per status",
            data: [
              { label: "Received", value: 12 },
              { label: "In repair", value: 7 },
              { label: "Ready", value: 4 },
            ],
          },
        },
        {
          kind: "Table",
          title: "Items",
          columns: [
            { key: "item", label: "Item" },
            { key: "status", label: "Status" },
            { key: "count", label: "Count" },
          ],
          rows: [
            { item: "Chair", status: "In repair", count: 2 },
            { item: "Bicycle", status: "Received", count: 1 },
            { item: "Lamp", status: "Ready", count: 5 },
          ],
        },
        { kind: "Table", title: "Waiting", columns: [{ key: "item", label: "Item" }], rows: [], empty: "Nothing waits." },
      ],
    },
    {
      kind: "Form",
      title: "Receive an item",
      action: "/receive",
      submit: "Receive",
      fields: [
        { type: "scan", name: "barcode", label: "Barcode", required: true, value: "W-1", error: "No item has this code." },
        { type: "text", name: "title", label: "Title", value: "Chair" },
        { type: "email", name: "contact", label: "Contact" },
        { type: "number", name: "count", label: "Count", value: 1 },
        {
          type: "select",
          name: "status",
          label: "Status",
          value: "received",
          options: [
            { value: "received", label: "Received" },
            { value: "repair", label: "In repair" },
          ],
        },
        { type: "checkbox", name: "urgent", label: "Urgent" },
        { type: "textarea", name: "note", label: "Note" },
      ],
    },
    {
      kind: "Detail",
      title: "Chair",
      items: [
        { label: "Code", value: "W-1" },
        { label: "Count", value: 1200 },
        { label: "Urgent", value: true },
      ],
    },
    { kind: "Heading", level: 3, text: "Next steps" },
    { kind: "Button", label: "Mark ready", action: "/ready", values: { item: "W-1" } },
    { kind: "Action", label: "Print label", action: "/print" },
    { kind: "Link", label: "All items", href: "/items" },
  ],
};
