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
