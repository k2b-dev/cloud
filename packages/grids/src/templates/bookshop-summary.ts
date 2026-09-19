import type { HtmlDocumentTemplateRenderer } from "../contracts";
import type { BookshopText } from "./bookshop";

/** A commercial order snapshot, deliberately without tax-invoice or payment terms. */
export const bookshopSummary = (t: BookshopText): HtmlDocumentTemplateRenderer => ({
  kind: "html",
  numberTemplate: "SUMMARY-{{ series.value }}",
  filenameTemplate: "{{ document.number }}.pdf",
  footer:
    '<div style="width:100%;text-align:center;font:9px Arial;color:#64748b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  css: `@page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body { font: 10pt/1.5 Arial, sans-serif; color: #0f172a; }
    h1 { font-size: 23pt; margin: 12mm 0 2mm; }
    p { margin: 0 0 3mm; }
    .muted { color: #64748b; font-size: 9pt; }
    .meta { display: flex; justify-content: space-between; gap: 8mm; margin: 8mm 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 8mm; }
    thead { display: table-header-group; }
    th, td { text-align: left; padding: 3mm 2mm; border-bottom: 1px solid #e2e8f0; }
    th { font-size: 9pt; color: #475569; }
    td:first-child { width: 48%; }
    .number { text-align: right; white-space: nowrap; }
    tr { break-inside: avoid; }
    .total { margin-top: 6mm; text-align: right; font-size: 13pt; font-weight: bold; }`,
  body: `<main>
    {% assign order = rows[0] %}
    {% assign total = 0 %}
    <p><strong>{{ business.legalName | default: app.name }}</strong></p>
    <p class="muted">{{ business.address | default: "" }} {{ business.postalCode | default: "" }} {{ business.city | default: "" }}</p>
    <h1>${t.orderInvoice}</h1>
    <p class="muted">${t.orderInvoiceDescription}</p>
    <div class="meta">
      <div><strong>${t.customer}</strong><br>{{ order.recipient_name }}<br>{{ order.recipient_email }}</div>
      <div><strong>{{ order.invoice_number }}</strong><br>${t.orderedAt}: {{ order.invoice_date }}</div>
    </div>
    <table>
      <thead><tr><th>${t.book}</th><th class="number">${t.quantity}</th><th class="number">${t.unitPrice}</th><th class="number">${t.lineTotal}</th></tr></thead>
      <tbody>{% for row in rows %}
        {% assign total = total | plus: row.invoice_line_total %}
        <tr><td>{{ row.invoice_item }}</td><td class="number">{{ row.invoice_quantity }}</td><td class="number">{{ row.invoice_unit_price | round: 2 }} EUR</td><td class="number">{{ row.invoice_line_total | round: 2 }} EUR</td></tr>
      {% endfor %}</tbody>
    </table>
    <p class="total">${t.orderValue}: {{ total | round: 2 }} EUR</p>
  </main>`,
});
