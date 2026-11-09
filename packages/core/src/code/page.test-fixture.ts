/** One Code page with every block, as a workshop Code would return it. Checked by tests before use. */
export const codePageFixture = {
  version: 1,
  kind: "Page",
  title: "Workshop",
  eyebrow: "Repair shop",
  asOf: "2026-11-07T09:40:00Z",
  icon: "ti ti-tool",
  color: "blue",
  follow: ["grids.record.changed"],
  children: [
    { kind: "Notice", tone: "warning", title: "Two items wait for a check", text: "Scan an item to open it." },
    {
      kind: "Stats",
      items: [
        {
          label: "Received this week",
          value: 128,
          delta: { value: 0.123, better: "up" },
          compare: { label: "Last week", value: 114 },
          trend: [92, 101, 97, 108, 114, 110, 121, 128],
        },
        {
          label: "Repair time",
          value: 2.4,
          format: { unit: "d", decimals: 1 },
          delta: { value: -0.077, better: "down" },
          compare: { label: "Last week", value: 2.6 },
        },
        { label: "Ready for pickup", value: 23, delta: { value: 0 }, compare: { label: "Yesterday", value: 23 } },
        {
          label: "Repair revenue",
          value: 4610,
          format: { style: "currency", currency: "EUR" },
          delta: { value: 0.152, better: "up" },
          compare: { label: "Last week", value: 4002 },
        },
      ],
    },
    { kind: "Text", text: "Everything the workshop handles today." },
    {
      kind: "Section",
      title: "Today",
      description: "Updated with every change",
      icon: "ti ti-calendar-event",
      color: "blue",
      children: [
        {
          kind: "Chart",
          width: "twoThirds",
          description: {
            kind: "bar",
            title: "Items per status",
            subtitle: "Open items right now",
            data: [
              { label: "Received", value: 12 },
              { label: "In repair", value: 7 },
              { label: "Ready", value: 4 },
            ],
          },
        },
        {
          kind: "Detail",
          width: "third",
          title: "Chair",
          items: [
            { label: "Code", value: "W-1" },
            { label: "Count", value: 1200 },
            { label: "Urgent", value: true },
          ],
        },
        {
          kind: "Table",
          title: "Items",
          columns: [
            { key: "item", label: "Item" },
            { key: "status", label: "Status" },
            { key: "count", label: "Count" },
            { key: "price", label: "Price", format: { style: "currency", currency: "EUR" } },
          ],
          rows: [
            { item: "Chair", status: "In repair", count: 2, price: 180 },
            { item: "Bicycle", status: "Received", count: 1, price: 95.5 },
            { item: "Lamp", status: "Ready", count: 5, price: 42 },
          ],
        },
      ],
    },
    {
      kind: "Section",
      title: "Receive",
      icon: "ti ti-package-import",
      color: "emerald",
      children: [
        {
          kind: "Form",
          width: "twoThirds",
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
        { kind: "Table", width: "third", title: "Waiting", columns: [{ key: "item", label: "Item" }], rows: [], empty: "Nothing waits." },
      ],
    },
    { kind: "Heading", level: 3, text: "Next steps" },
    { kind: "Button", label: "Mark ready", action: "/ready", values: { item: "W-1" } },
    { kind: "Button", label: "Print label", action: "/print" },
    { kind: "Link", label: "All items", href: "/items" },
  ],
};
