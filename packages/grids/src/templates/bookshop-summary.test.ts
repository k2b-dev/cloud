import { expect, test } from "bun:test";
import { renderDocumentHtml } from "../service/documents";
import { createBookshopTemplate } from "./bookshop";

for (const locale of ["en", "de"]) {
  test(`bookshop summary renders every agreed price and keeps tax-invoice claims out (${locale})`, async () => {
    const template = createBookshopTemplate(locale).documentTemplates?.find((entry) => entry.key === "order_invoice");
    if (!template?.renderer) throw new Error("Order summary renderer missing");
    const rendered = await renderDocumentHtml(
      { renderer: template.renderer },
      {
        app: { name: "Bookshop" },
        business: { legalName: "Books & Friends", address: "", postalCode: "", city: "" },
        document: { number: "SUMMARY-1" },
        rows: [
          {
            invoice_number: "ORD-2026-0042",
            invoice_date: "2026-09-19",
            recipient_name: "Reader <One>",
            recipient_email: "reader@example.test",
            invoice_item: "A & B",
            invoice_quantity: "2",
            invoice_unit_price: "9.99",
            invoice_line_total: "19.98",
          },
          {
            invoice_number: "ORD-2026-0042",
            invoice_date: "2026-09-19",
            recipient_name: "Reader <One>",
            recipient_email: "reader@example.test",
            invoice_item: "Second book",
            invoice_quantity: "1",
            invoice_unit_price: "10.50",
            invoice_line_total: "10.50",
          },
        ],
      },
    );
    expect(rendered.ok, rendered.ok ? "" : rendered.error.message).toBe(true);
    if (!rendered.ok) throw new Error(rendered.error.message);
    expect(rendered.data).toContain(locale === "de" ? "<h1>Bestellübersicht</h1>" : "<h1>Order summary</h1>");
    expect(rendered.data).toContain("Reader &lt;One&gt;");
    expect(rendered.data).toContain("A &amp; B");
    expect(rendered.data).toContain("Second book");
    expect(rendered.data).toContain("30.48 EUR");
    expect(rendered.data).not.toContain("<h1>Invoice</h1>");
    expect(rendered.data).not.toContain("<h1>Rechnung</h1>");
    expect(rendered.data).not.toContain("Due on receipt");
  });
}

for (const locale of ["en", "de"]) {
  test(`bookshop separates physical fulfillment from optional summary delivery (${locale})`, () => {
    const template = createBookshopTemplate(locale);
    const page = template.customApps?.[0]?.definition.pages.find((entry) => entry.id === "order");
    if (!page) throw new Error("Order page missing");
    const firstRow = page.rows[0];
    const identity = firstRow?.columns.flatMap((column) => column.blocks).find((block) => block.id === "identity");
    expect(identity?.type).toBe("record");
    if (!identity || !("fieldIds" in identity) || !("editableFieldIds" in identity)) throw new Error("Order identity missing");
    expect(identity.fieldIds).toContainEqual({ $ref: "field", key: "orders.status" });
    expect(identity.editableFieldIds).toEqual([]);
    const orderBlocks = page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    for (const id of ["edit-order", "add-line"]) {
      const block = orderBlocks.find((entry) => entry.id === id);
      expect(JSON.stringify(block?.availableWhen)).toContain("orders.status");
      expect(JSON.stringify(block?.availableWhen)).toContain(" != 'delivered'");
    }
    const nextStep = firstRow?.columns.find((column) => column.id === "next-step");
    if (!nextStep) throw new Error("Fulfillment must be available before the line list, including on narrow screens");
    const nextActions = nextStep.blocks.flatMap((block) => ("actions" in block ? block.actions : []));
    expect(nextActions.map((action) => action.id)).toContain("mark-order-shipped");
    expect(nextActions.map((action) => action.id)).toContain("complete-order");
    expect(nextActions.map((action) => action.id)).toContain("reopen-order");
    expect(nextActions.map((action) => action.id)).not.toContain("send-invoice");
    expect(JSON.stringify(nextStep)).not.toContain("orders.invoice_sent");
    const send = orderBlocks.flatMap((block) => ("actions" in block ? block.actions : [])).find((action) => action.id === "send-invoice");
    expect(send?.variant).toBe("secondary");
    if (!send || !("confirm" in send)) throw new Error("Summary delivery requires explicit confirmation");
    expect(send.confirm).toBeTruthy();
    expect(JSON.stringify(send.availableWhen)).not.toContain("orders.status");
    expect(template.tables.find((table) => table.key === "orders")?.fields.some((field) => field.key === "invoice_ready")).toBe(false);
    expect(JSON.stringify(page)).not.toContain("orders.invoice_ready");
  });
}
