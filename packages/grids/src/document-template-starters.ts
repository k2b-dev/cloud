import type { HtmlDocumentTemplateRenderer } from "./contracts";

export type DocumentTemplateStarter = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  bestFor: string;
  expectedData: string;
  page: string;
  uses?: string[];
  source: (tableId: string) => string;
  renderer: HtmlDocumentTemplateRenderer;
};

const defaultNumberTemplate = "DOC-{{ series.value }}";
const defaultFilenameTemplate = "{{ document.number }}.pdf";

const recordSource = (tableId: string) => `from table {${tableId}}\nwhere record.id = '{{ record.id }}'\nlimit 1`;
const overviewSource = (tableId: string) => `from table {${tableId}}\nlimit 100`;

const primaryValue = `{% if rows.size > 0 and columns.size > 0 %}{% assign first = rows[0] %}{% assign firstColumn = columns[0] %}{{ first[firstColumn.key] | default: table.name }}{% else %}{{ table.name }}{% endif %}`;

const businessHeader = `<style>
  html, body { margin: 0; }
  body { font-family: Inter, Arial, sans-serif; color: #334155; font-size: 8pt; }
  .header { box-sizing: border-box; width: 100%; padding: 7mm 14mm 5mm; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8mm; }
  .brand-lockup { display: flex; align-items: center; gap: 3.2mm; min-width: 0; }
  .cloud-logo { width: 12mm; height: 12mm; flex: 0 0 auto; display: block; }
  .brand { color: #0f172a; font-weight: 850; font-size: 10.5pt; letter-spacing: .08em; text-transform: uppercase; }
  .line { margin-top: .8mm; color: #64748b; white-space: pre-line; }
  .meta { text-align: right; white-space: nowrap; line-height: 1.35; }
  .meta strong { color: #0f172a; }
</style>
<div class="header">
  <div class="brand-lockup">
    <img class="cloud-logo" src="{{ app.logoDataUri }}" alt="">
    <div>
      <div class="brand">{{ business.legalName | default: app.name }}</div>
      <div class="line">{{ business.address | default: business.senderLine | default: app.url }}</div>
    </div>
  </div>
  <div class="meta">
    <strong>{{ business.department | default: "Document Services" }}</strong><br>
    {% if business.contactEmail %}{{ business.contactEmail }}{% elsif app.contactEmail %}{{ app.contactEmail }}{% endif %}<br>
    {% if business.phone %}{{ business.phone }}{% elsif business.url %}{{ business.url }}{% elsif app.url %}{{ app.url }}{% endif %}
  </div>
</div>`;

const businessFooter = `<style>
  html, body { margin: 0; }
  body { font-family: Inter, Arial, sans-serif; color: #64748b; font-size: 7.2pt; }
  .footer { box-sizing: border-box; width: 100%; border-top: 1px solid #d6dee8; padding: 2.4mm 14mm 0; display: grid; grid-template-columns: 1.2fr 1fr auto; gap: 6mm; line-height: 1.35; }
  .center { text-align: center; }
  .right { text-align: right; }
</style>
<div class="footer">
  <span>{% if business.footerText %}{{ business.footerText }}{% else %}{{ business.legalName | default: app.name }}{% if business.registration %} | {{ business.registration }}{% endif %}{% if business.taxId %} | {{ business.taxId }}{% endif %}{% endif %}</span>
  <span class="center">{% if business.iban %}IBAN {{ business.iban }}{% endif %}{% if business.bic %} | BIC {{ business.bic }}{% endif %}</span>
  <span class="right">Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

const standardPageCss = `@page { size: A4; margin: 34mm 14mm 22mm; }
* { box-sizing: border-box; }
body { font-family: Inter, Arial, sans-serif; color: #111827; font-size: 10pt; line-height: 1.45; }
h1 { margin: 0; font-size: 22pt; line-height: 1.1; letter-spacing: 0; }
h2 { margin: 7mm 0 2.5mm; font-size: 11pt; color: #0f172a; }
p { margin: 0 0 3mm; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
th, td { border-bottom: 1px solid #e2e8f0; padding: 7px 6px; text-align: left; vertical-align: top; }
th { color: #475569; font-size: 8pt; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
.document-title { display: grid; grid-template-columns: 1fr auto; gap: 12mm; align-items: start; margin-bottom: 9mm; }
.document-kicker { margin-bottom: 2mm; color: #64748b; font-size: 8pt; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.document-meta { min-width: 56mm; color: #334155; }
.meta-row { display: flex; justify-content: space-between; gap: 8mm; padding: 1.2mm 0; }
.muted { color: #64748b; }
.strong { font-weight: 800; color: #0f172a; }
.right { text-align: right; }
.box { border: 1px solid #d1d5db; border-radius: 4px; padding: 5mm; }
.soft-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 5mm; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.address { min-height: 34mm; }
.small { font-size: 8.5pt; }
.checkbox { display: inline-block; width: 4.2mm; height: 4.2mm; border: 1.4px solid #0f172a; border-radius: 1px; vertical-align: middle; }
.signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16mm; margin-top: 18mm; }
.signature { min-height: 18mm; border-top: 1.2px solid #0f172a; padding-top: 2mm; color: #334155; }
.summary-card { margin-left: auto; width: 74mm; }
.summary-row { display: flex; justify-content: space-between; gap: 8mm; padding: 1.5mm 0; }
.summary-row:last-child { border-top: 1px solid #cbd5e1; margin-top: 1.5mm; padding-top: 2.5mm; }
.letter-sender { color: #64748b; font-size: 8pt; margin-bottom: 4mm; }
.recipient-window { min-height: 38mm; padding-top: 1mm; }
.letter-layout { display: grid; grid-template-columns: 1fr 68mm; gap: 14mm; align-items: start; margin-bottom: 11mm; }
.letter-contact { background: #f8fafc; border-left: 3px solid #0f172a; padding: 4mm 5mm; color: #334155; }
.document-band { padding: 0; margin: 12mm 0 9mm; display: grid; grid-template-columns: 1fr auto; gap: 10mm; align-items: end; }
.document-band h1 { font-size: 22pt; }
.document-number { color: #334155; font-size: 10pt; text-align: right; }
.section-title { margin-top: 7mm; margin-bottom: 2.5mm; color: #0f172a; font-size: 8.5pt; font-weight: 850; letter-spacing: .06em; text-transform: uppercase; }
.clause { margin-top: 6mm; }
.clause h2 { margin: 0 0 2mm; font-size: 11pt; }
.compact-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm; }
.stamp-box { border: 1px solid #0f172a; padding: 4mm; text-align: center; font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; color: #334155; }
.fine-print { color: #64748b; font-size: 8pt; }
.form-line { display: inline-block; min-width: 28mm; height: 1em; border-bottom: 1px solid #94a3b8; vertical-align: baseline; }
.preline { white-space: pre-line; }`;

const rowsTable = `<table>
  <thead>
    <tr>
      {% for column in columns %}
        <th>{{ column.label }}</th>
      {% endfor %}
    </tr>
  </thead>
  <tbody>
    {% for row in rows %}
      <tr>
        {% for column in columns %}
          <td>{{ row[column.key] | default: "-" }}</td>
        {% endfor %}
      </tr>
    {% endfor %}
  </tbody>
</table>`;

const detailTable = `<table>
  <tbody>
    {% for row in rows %}
      {% for column in columns %}
        <tr>
          <th style="width: 32%;">{{ column.label }}</th>
          <td>{{ row[column.key] | default: "-" }}</td>
        </tr>
      {% endfor %}
    {% endfor %}
  </tbody>
</table>`;

export const DOCUMENT_TEMPLATE_STARTERS: DocumentTemplateStarter[] = [
  {
    id: "invoice",
    name: "Invoice",
    description: "Professional invoice starter with sender, recipient, item table, payment terms, and totals block.",
    icon: "ti ti-receipt",
    category: "Commercial",
    bestFor: "Customer invoices and billing records.",
    expectedData:
      "One row per invoice item. Alias invoice_number, invoice_date, recipient_name, recipient_email, invoice_item, invoice_quantity, invoice_unit_price, and invoice_line_total.",
    page: "A4 portrait",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.invoice-table { margin-top: 7mm; }
.invoice-table tbody tr:nth-child(even) { background: #f8fafc; }
.payment-note { margin-top: 8mm; }
.total-due { font-size: 14pt; font-weight: 900; color: #0f172a; }`,
      body: `<main>
  {% assign hasInvoice = false %}
  {% if rows.size > 0 %}{% assign invoice = rows[0] %}{% assign hasInvoice = true %}{% endif %}
  {% assign invoiceTotal = 0 %}
  {% assign invoiceNumberColumns = columns | where: "key", "invoice_number" %}
  {% assign invoiceDateColumns = columns | where: "key", "invoice_date" %}
  {% assign recipientNameColumns = columns | where: "key", "recipient_name" %}
  {% assign recipientEmailColumns = columns | where: "key", "recipient_email" %}
  {% assign itemColumns = columns | where: "key", "invoice_item" %}
  {% assign quantityColumns = columns | where: "key", "invoice_quantity" %}
  {% assign unitPriceColumns = columns | where: "key", "invoice_unit_price" %}
  {% assign lineTotalColumns = columns | where: "key", "invoice_line_total" %}
  <section class="letter-layout avoid-break">
    <div>
      <div class="letter-sender">{{ business.senderLine | default: business.legalName | default: app.name }}</div>
      <div class="recipient-window">
        {% if hasInvoice %}
          {% if recipientNameColumns.size > 0 %}
            <p class="strong">{{ invoice[recipientNameColumns[0].key] | default: "Recipient not provided" }}</p>
          {% else %}
            <p class="strong">Recipient not provided</p>
          {% endif %}
          {% if recipientEmailColumns.size > 0 %}<p>{{ invoice[recipientEmailColumns[0].key] }}</p>{% endif %}
        {% else %}
          <p class="strong">Recipient not provided</p>
        {% endif %}
      </div>
    </div>
    <aside class="letter-contact">
      <p class="strong">{{ business.legalName | default: app.name }}</p>
      <p class="preline">{{ business.address | default: "" }}</p>
      <p class="small muted">{% if business.contactEmail %}{{ business.contactEmail }}<br>{% endif %}{% if business.phone %}{{ business.phone }}<br>{% endif %}{% if business.url %}{{ business.url }}{% endif %}</p>
    </aside>
  </section>

  <section class="document-band avoid-break">
    <div>
      <div class="document-kicker">Commercial document</div>
      <h1>Invoice</h1>
      <p class="fine-print" style="margin-top: 2mm;">Services and goods according to the itemized statement below.</p>
    </div>
    <div class="document-number">
      {% if hasInvoice %}
        <strong>{% if invoiceNumberColumns.size > 0 %}{{ invoice[invoiceNumberColumns[0].key] | default: document.number | default: "Invoice" }}{% else %}{{ document.number | default: "Invoice" }}{% endif %}</strong><br>
        {% if invoiceDateColumns.size > 0 %}{{ invoice[invoiceDateColumns[0].key] | default: document.createdAt | default: "Issue date not provided" }}{% else %}{{ document.createdAt | default: "Issue date not provided" }}{% endif %}
      {% else %}
        <strong>{{ document.number | default: "Invoice" }}</strong><br>
        {{ document.createdAt | default: "Issue date not provided" }}
      {% endif %}
    </div>
  </section>

  <section class="compact-grid avoid-break">
    <div class="soft-box">
      <div class="document-kicker">Invoice reference</div>
      {% if hasInvoice %}
        <p class="strong">{% if invoiceNumberColumns.size > 0 %}{{ invoice[invoiceNumberColumns[0].key] | default: document.number | default: "-" }}{% else %}{{ document.number | default: "-" }}{% endif %}</p>
      {% else %}
        <p class="strong">{{ document.number | default: "-" }}</p>
      {% endif %}
    </div>
    <div class="soft-box">
      <div class="document-kicker">Payment terms</div>
      <p class="strong">{{ business.paymentTerms | default: "Due on receipt" }}</p>
    </div>
    <div class="soft-box">
      <div class="document-kicker">Currency</div>
      <p class="strong">EUR</p>
    </div>
  </section>

  <div class="invoice-table">
    {% if itemColumns.size > 0 and quantityColumns.size > 0 and unitPriceColumns.size > 0 and lineTotalColumns.size > 0 %}
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="right">Quantity</th>
          <th class="right">Unit price</th>
          <th class="right">Line total</th>
        </tr>
      </thead>
      <tbody>
        {% for row in rows %}
          {% assign lineTotal = row[lineTotalColumns[0].key] | default: 0 %}
          {% assign invoiceTotal = invoiceTotal | plus: lineTotal %}
          <tr>
            <td>{{ row[itemColumns[0].key] | default: "-" }}</td>
            <td class="right">{{ row[quantityColumns[0].key] | default: 0 }}</td>
            <td class="right">{{ row[unitPriceColumns[0].key] | default: 0 | round: 2 }} EUR</td>
            <td class="right"><strong>{{ lineTotal | round: 2 }} EUR</strong></td>
          </tr>
        {% else %}
          <tr><td colspan="4" class="muted">No invoice items were returned by the template query.</td></tr>
        {% endfor %}
      </tbody>
    </table>
    {% else %}
      ${rowsTable}
    {% endif %}
  </div>

  {% if lineTotalColumns.size > 0 %}
  <section class="summary-card soft-box avoid-break">
    <div class="summary-row"><span>Subtotal</span><strong>{{ invoiceTotal | round: 2 }} EUR</strong></div>
    <div class="summary-row"><span>Total due</span><span class="total-due">{{ invoiceTotal | round: 2 }} EUR</span></div>
  </section>
  {% endif %}

  <section class="grid-2 payment-note avoid-break">
    <div>
      <div class="section-title">Payment instructions</div>
      <p>Please transfer the total amount{% if business.iban %} to the bank account stated in the footer{% endif %} and include the invoice number as payment reference.</p>
    </div>
    <div>
      <div class="section-title">Notes</div>
      <p class="fine-print">This invoice was generated from approved operational records. Please quote the invoice number on all payment references and correspondence.</p>
    </div>
  </section>
</main>`,
    },
  },
  {
    id: "loan-agreement",
    name: "Loan agreement",
    description: "Business-ready loan agreement with parties, item list, terms, and signature blocks.",
    icon: "ti ti-file-certificate",
    category: "Contract",
    bestFor: "Equipment loans, borrower handovers, and signed internal agreements.",
    expectedData:
      "One selected loan record. Alias borrower_name, borrower_organization, borrower_email, loan_start, and return_due for populated party and date blocks.",
    page: "A4 portrait",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.agreement-intro { margin-bottom: 8mm; }
.agreement-table { margin-top: 4mm; }
.condition-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3mm 8mm; margin-top: 3mm; }
.condition-item { display: flex; align-items: center; gap: 2.5mm; }
.initial-box { border: 1px solid #94a3b8; min-height: 12mm; padding: 2.5mm; }`,
      body: `<main>
  {% assign hasLoan = false %}
  {% if rows.size > 0 %}{% assign loan = rows[0] %}{% assign hasLoan = true %}{% endif %}
  {% assign borrowerNameColumns = columns | where: "key", "borrower_name" %}
  {% assign borrowerOrganizationColumns = columns | where: "key", "borrower_organization" %}
  {% assign borrowerEmailColumns = columns | where: "key", "borrower_email" %}
  {% assign loanStartColumns = columns | where: "key", "loan_start" %}
  {% assign returnDueColumns = columns | where: "key", "return_due" %}
  <section class="letter-layout avoid-break">
    <div>
      <div class="letter-sender">{{ business.senderLine | default: business.legalName | default: app.name }}</div>
      <div class="recipient-window">
        <p class="strong">{% if hasLoan and borrowerNameColumns.size > 0 %}{{ loan[borrowerNameColumns[0].key] }}{% else %}Borrower name{% endif %}</p>
        <p>{% if hasLoan and borrowerOrganizationColumns.size > 0 %}{{ loan[borrowerOrganizationColumns[0].key] }}{% else %}Borrower organization{% endif %}{% if hasLoan and borrowerEmailColumns.size > 0 %}<br>{{ loan[borrowerEmailColumns[0].key] }}{% endif %}</p>
      </div>
    </div>
    <aside class="stamp-box">Internal loan document<br>Return required</aside>
  </section>

  <section class="document-band avoid-break">
    <div>
      <div class="document-kicker">Agreement</div>
      <h1>Equipment loan agreement</h1>
    </div>
    <div class="document-number">
      <strong>Loan ref. {{ document.number | default: "LN-0001" }}</strong><br>
      Prepared for signature
    </div>
  </section>

  <section class="grid-2 agreement-intro avoid-break">
    <div class="box">
      <div class="document-kicker">Lender</div>
      <p class="strong">{{ business.legalName | default: app.name }}</p>
      <p class="preline">{{ business.address | default: "" }}</p>
      <p class="small muted">Represented by authorized staff.</p>
    </div>
    <div class="box">
      <div class="document-kicker">Borrower</div>
      <p class="strong">{% if hasLoan and borrowerNameColumns.size > 0 %}{{ loan[borrowerNameColumns[0].key] }}{% else %}Borrower name{% endif %}</p>
      <p>{% if hasLoan and borrowerOrganizationColumns.size > 0 %}{{ loan[borrowerOrganizationColumns[0].key] }}{% else %}Borrower organization{% endif %}{% if hasLoan and borrowerEmailColumns.size > 0 %}<br>{{ loan[borrowerEmailColumns[0].key] }}{% endif %}</p>
      <p class="small muted">Identification checked before handover.</p>
    </div>
  </section>

  <section class="compact-grid avoid-break">
    <div class="soft-box"><div class="document-kicker">Loan starts</div><p class="strong">{% if hasLoan and loanStartColumns.size > 0 %}{{ loan[loanStartColumns[0].key] }}{% else %}To be agreed{% endif %}</p></div>
    <div class="soft-box"><div class="document-kicker">Return due</div><p class="strong">{% if hasLoan and returnDueColumns.size > 0 %}{{ loan[returnDueColumns[0].key] }}{% else %}To be agreed{% endif %}</p></div>
    <div class="soft-box"><div class="document-kicker">Return condition</div><p class="strong">As issued</p></div>
  </section>

  <div class="section-title">Loaned equipment</div>
  <div class="agreement-table">${rowsTable}</div>

  <section class="clause avoid-break">
    <h2>1. Handover and responsibility</h2>
    <p>The borrower confirms receipt of the listed equipment in the condition documented at handover. The borrower is responsible for careful handling, secure storage, and timely return.</p>
  </section>

  <section class="clause avoid-break">
    <h2>2. Condition checklist</h2>
    <div class="condition-grid">
      <div class="condition-item"><span class="checkbox"></span><span>Equipment complete</span></div>
      <div class="condition-item"><span class="checkbox"></span><span>Accessories included</span></div>
      <div class="condition-item"><span class="checkbox"></span><span>Visible damage documented</span></div>
      <div class="condition-item"><span class="checkbox"></span><span>Return date explained</span></div>
    </div>
  </section>

  <section class="clause avoid-break">
    <h2>3. Loss, damage, and late return</h2>
    <p>Loss, damage, missing accessories, or late return may be charged according to replacement value, repair cost, or the applicable internal policy.</p>
  </section>

  <section class="signature-grid avoid-break">
    <div>
      <div class="initial-box small muted">Internal notes / handover initials</div>
      <div class="signature">Place, date, lender signature</div>
    </div>
    <div>
      <div class="initial-box small muted">Borrower initials</div>
      <div class="signature">Place, date, borrower signature</div>
    </div>
  </section>
</main>`,
    },
  },
  {
    id: "label",
    name: "Label",
    description: "90mm x 54mm operational label with a print-ready Code 128 barcode.",
    icon: "ti ti-barcode",
    category: "Label",
    bestFor: "Asset labels, shelf labels, and compact operational identifiers.",
    expectedData: "One selected record; the first selected column becomes the barcode value.",
    page: "90mm x 54mm",
    uses: ["Code 128 barcode"],
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      css: `@page { size: 90mm 54mm; margin: 0; }
* { box-sizing: border-box; }
html, body { width: 90mm; height: 54mm; margin: 0; }
body { font-family: Inter, Arial, sans-serif; color: #0f172a; padding: 6mm; }
.label { width: 78mm; height: 42mm; border: 1.6px solid #0f172a; border-radius: 5px; padding: 4.5mm 5mm; display: flex; flex-direction: column; overflow: hidden; }
.kicker { font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 800; }
.name { margin-top: 2.4mm; font-size: 17pt; line-height: 1.05; font-weight: 850; }
.code { margin-top: auto; width: 100%; height: 13mm; object-fit: contain; object-position: left bottom; }`,
      body: `<section class="label">
  {% if rows.size > 0 and columns.size > 0 %}
    {% assign first = rows[0] %}
    {% assign codeColumn = columns[0] %}
    {% assign codeValue = first[codeColumn.key] | default: table.name %}
  {% else %}
    {% assign codeValue = table.name %}
  {% endif %}
  <div class="kicker">{{ table.name }}</div>
  <div class="name">${primaryValue}</div>
  <img class="code" src="{{ codeValue | barcode_data_url: "code128", true }}" alt="">
</section>`,
    },
  },
  {
    id: "qr-label",
    name: "QR label",
    description: "90mm x 54mm label with a large QR code for links, assets, or compact record data.",
    icon: "ti ti-qrcode",
    category: "Label",
    bestFor: "Asset tags, links, compact identifiers, and scan workflows.",
    expectedData: "One selected record; the first selected column becomes the QR value.",
    page: "90mm x 54mm",
    uses: ["QR code"],
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      css: `@page { size: 90mm 54mm; margin: 0; }
* { box-sizing: border-box; }
html, body { width: 90mm; height: 54mm; margin: 0; }
body { font-family: Inter, Arial, sans-serif; color: #0f172a; padding: 6mm; }
.label { width: 78mm; height: 42mm; border: 1.6px solid #0f172a; border-radius: 5px; padding: 4.5mm; display: grid; grid-template-columns: 29mm 1fr; gap: 5mm; align-items: center; overflow: hidden; }
.qr { width: 28mm; height: 28mm; object-fit: contain; }
.kicker { font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 800; }
.name { margin-top: 2.4mm; font-size: 15pt; line-height: 1.08; font-weight: 850; }
.hint { margin-top: 2.2mm; color: #475569; font-size: 7.5pt; line-height: 1.25; }`,
      body: `<section class="label">
  {% if rows.size > 0 and columns.size > 0 %}
    {% assign first = rows[0] %}
    {% assign codeColumn = columns[0] %}
    {% assign codeValue = first[codeColumn.key] | default: table.name %}
  {% else %}
    {% assign codeValue = table.name %}
  {% endif %}
  <img class="qr" src="{{ codeValue | barcode_data_url: "qrcode" }}" alt="">
  <div>
    <div class="kicker">{{ table.name }}</div>
    <div class="name">${primaryValue}</div>
    <div class="hint">Scan for the selected record value.</div>
  </div>
</section>`,
    },
  },
  {
    id: "overview",
    name: "Overview report",
    description: "Multipage business report over many records.",
    icon: "ti ti-table",
    category: "Report",
    bestFor: "Printable lists, exports, and internal status reports.",
    expectedData: "Up to 100 rows from the source table by default.",
    page: "A4 portrait",
    source: overviewSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: standardPageCss,
      body: `<main>
  <section class="document-title avoid-break">
    <div>
      <div class="document-kicker">Report</div>
      <h1>{{ table.name }} overview</h1>
    </div>
    <div class="document-meta">
      <div class="meta-row"><span>Scope</span><strong>Current GQL source</strong></div>
      <div class="meta-row"><span>Rows</span><strong>{{ rows.size }}</strong></div>
    </div>
  </section>
  ${rowsTable}
</main>`,
    },
  },
  {
    id: "record-detail",
    name: "Record detail",
    description: "One-record business detail sheet with optional image header and full-width detail table.",
    icon: "ti ti-id",
    category: "Record",
    bestFor: "Record dossiers, asset sheets, and customer/account detail pages.",
    expectedData: "One selected record; image file fields appear as primaryImage/images.",
    page: "A4 portrait",
    uses: ["record images"],
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.record-title { padding: 0; margin: 2mm 0 9mm; }
.record-image { width: 36mm; height: 36mm; object-fit: cover; border-radius: 4px; border: 1px solid #d1d5db; }
.record-details { width: 100%; }
.record-details table { width: 100%; }`,
      body: `<main>
  <section class="document-title record-title avoid-break">
    <div>
      <div class="document-kicker">Record detail</div>
      <h1>${primaryValue}</h1>
      <p class="fine-print" style="margin-top: 3mm;">Source: {{ table.name }}</p>
    </div>
    {% if primaryImage %}
      <img class="record-image" src="{{ primaryImage.url }}" alt="{{ primaryImage.filename | default: primaryImage.fieldName | default: 'Record image' }}">
    {% endif %}
  </section>
  <section class="record-details">
    ${detailTable}
  </section>
</main>`,
    },
  },
  {
    id: "delivery-note",
    name: "Delivery note",
    description: "Delivery note with sender, recipient, delivery metadata, and item table.",
    icon: "ti ti-truck-delivery",
    category: "Logistics",
    bestFor: "Shipments, handovers, and delivery confirmations.",
    expectedData: "One delivery record plus selected delivery/item fields.",
    page: "A4 portrait",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: standardPageCss,
      body: `<main>
  <section class="document-title avoid-break">
    <div>
      <div class="document-kicker">Logistics</div>
      <h1>Delivery note</h1>
    </div>
    <div class="document-meta">
      <div class="meta-row"><span>Delivery no.</span><strong>{{ document.number | default: "DN-0001" }}</strong></div>
      <div class="meta-row"><span>Carrier</span><strong>Internal delivery</strong></div>
    </div>
  </section>
  <section class="grid-2 avoid-break">
    <div class="address box"><div class="document-kicker">Ship from</div><p class="strong">{{ business.legalName | default: app.name }}</p><p class="preline">{{ business.address | default: "" }}</p></div>
    <div class="address box"><div class="document-kicker">Ship to</div><p class="strong">Recipient</p><p>Delivery address<br>Contact person</p></div>
  </section>
  <h2>Delivered items</h2>
  ${rowsTable}
  <section class="signature-grid avoid-break">
    <div class="signature">Delivered by</div>
    <div class="signature">Received by</div>
  </section>
</main>`,
    },
  },
  {
    id: "quote",
    name: "Quote",
    description: "Offer starter with customer block, line items, validity, and commercial terms.",
    icon: "ti ti-file-dollar",
    category: "Commercial",
    bestFor: "Offers, cost estimates, and commercial proposals.",
    expectedData: "One quote record plus selected position fields.",
    page: "A4 portrait",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: standardPageCss,
      body: `<main>
  <section class="document-title avoid-break">
    <div>
      <div class="document-kicker">Commercial offer</div>
      <h1>Quote</h1>
    </div>
    <div class="document-meta">
      <div class="meta-row"><span>Quote no.</span><strong>{{ document.number | default: "Q-0001" }}</strong></div>
      <div class="meta-row"><span>Valid until</span><strong>30 days</strong></div>
    </div>
  </section>
  <section class="grid-2 avoid-break">
    <div class="address box"><div class="document-kicker">Supplier</div><p class="strong">{{ business.legalName | default: app.name }}</p><p class="preline">{{ business.address | default: "" }}</p></div>
    <div class="address box"><div class="document-kicker">Customer</div><p class="strong">Customer Company</p><p>Customer address<br>Procurement contact</p></div>
  </section>
  <h2>Offer positions</h2>
  ${rowsTable}
  <section class="soft-box avoid-break" style="margin-top: 8mm;">
    <p class="strong">Terms</p>
    <p class="muted">Prices are net prices unless stated otherwise. Delivery, payment, and availability are subject to written confirmation.</p>
  </section>
</main>`,
    },
  },
  {
    id: "packing-list",
    name: "Packing list",
    description: "Operational packing list with real printed checkbox boxes and multipage-safe rows.",
    icon: "ti ti-package",
    category: "Operations",
    bestFor: "Picking, packing, preparation, and physical checklists.",
    expectedData: "Multiple rows from the source table.",
    page: "A4 portrait",
    uses: ["printed checkboxes"],
    source: overviewSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.check-col { width: 12mm; text-align: center; }
.packed-table td.check-col { padding-top: 8px; }`,
      body: `<main>
  <section class="document-title avoid-break">
    <div>
      <div class="document-kicker">Warehouse</div>
      <h1>Packing list</h1>
    </div>
    <div class="document-meta">
      <div class="meta-row"><span>Prepared by</span><strong>Operations</strong></div>
      <div class="meta-row"><span>Rows</span><strong>{{ rows.size }}</strong></div>
    </div>
  </section>
  <table class="packed-table">
    <thead><tr><th class="check-col">Packed</th>{% for column in columns %}<th>{{ column.label }}</th>{% endfor %}</tr></thead>
    <tbody>
      {% for row in rows %}
        <tr><td class="check-col"><span class="checkbox"></span></td>{% for column in columns %}<td>{{ row[column.key] | default: "-" }}</td>{% endfor %}</tr>
      {% endfor %}
    </tbody>
  </table>
</main>`,
    },
  },
  {
    id: "certificate",
    name: "Certificate",
    description: "Formal certificate or confirmation for one selected record.",
    icon: "ti ti-certificate",
    category: "Formal",
    bestFor: "Confirmations, certificates, and signed proof documents.",
    expectedData: "One selected record.",
    page: "A4 portrait",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.certificate { min-height: 185mm; border: 2px solid #0f172a; padding: 18mm; text-align: center; }
.certificate h1 { font-size: 24pt; margin-top: 18mm; }
.certificate-detail { margin: 16mm auto 0; max-width: 130mm; text-align: left; }`,
      body: `<main class="certificate">
  <div class="document-kicker">{{ table.name }}</div>
  <h1>Certificate</h1>
  <p>This document confirms the following record information.</p>
  <p class="strong" style="font-size: 14pt; margin-top: 6mm;">${primaryValue}</p>
  <div class="certificate-detail">${detailTable}</div>
  <section class="signature-grid avoid-break">
    <div class="signature">Place, date</div>
    <div class="signature">Authorized signature</div>
  </section>
</main>`,
    },
  },
  {
    id: "checklist",
    name: "Checklist",
    description: "Printable checklist with real checkbox boxes and detail lines.",
    icon: "ti ti-list-check",
    category: "Operations",
    bestFor: "Manual review, setup, inspection, and recurring operational tasks.",
    expectedData: "Multiple rows from the source table.",
    page: "A4 portrait",
    uses: ["printed checkboxes"],
    source: overviewSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      header: businessHeader,
      footer: businessFooter,
      css: `${standardPageCss}
.task-col { width: 13mm; text-align: center; }
.details { color: #334155; }`,
      body: `<main>
  <section class="document-title avoid-break">
    <div>
      <div class="document-kicker">Checklist</div>
      <h1>{{ table.name }}</h1>
    </div>
    <div class="document-meta">
      <div class="meta-row"><span>Owner</span><strong>Operations</strong></div>
      <div class="meta-row"><span>Items</span><strong>{{ rows.size }}</strong></div>
    </div>
  </section>
  <table>
    <thead><tr><th class="task-col">Done</th><th>Task</th><th>Details</th></tr></thead>
    <tbody>
      {% for row in rows %}
        {% if columns.size > 0 %}{% assign firstColumn = columns[0] %}{% endif %}
        <tr>
          <td class="task-col"><span class="checkbox"></span></td>
          <td class="strong">{% if firstColumn %}{{ row[firstColumn.key] | default: "Item" }}{% else %}Item{% endif %}</td>
          <td class="details">{% for column in columns %}<strong>{{ column.label }}:</strong> {{ row[column.key] | default: "-" }}<br>{% endfor %}</td>
        </tr>
      {% endfor %}
    </tbody>
  </table>
</main>`,
    },
  },
  {
    id: "badge",
    name: "Badge / name tag",
    description: "Simple professional badge without internal identifiers.",
    icon: "ti ti-badge",
    category: "Badge",
    bestFor: "Name tags, event badges, and simple identity cards.",
    expectedData: "One selected record.",
    page: "85mm x 55mm",
    source: recordSource,
    renderer: {
      kind: "html",
      numberTemplate: defaultNumberTemplate,
      filenameTemplate: defaultFilenameTemplate,
      css: `@page { size: 85mm 55mm; margin: 0; }
* { box-sizing: border-box; }
body { width: 85mm; height: 55mm; margin: 0; padding: 6mm; font-family: Inter, Arial, sans-serif; color: #0f172a; }
.badge { height: 43mm; border-radius: 6px; border: 1px solid #cbd5e1; padding: 6mm; text-align: center; overflow: hidden; display: flex; flex-direction: column; justify-content: center; }
.name { font-size: 21pt; font-weight: 850; line-height: 1.05; }
.meta { margin-top: 3mm; color: #64748b; font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; font-weight: 800; }`,
      body: `<section class="badge">
  <div class="name">${primaryValue}</div>
  <div class="meta">{{ table.name }}</div>
</section>`,
    },
  },
];

type StarterLocalizedMetadata = Pick<DocumentTemplateStarter, "name" | "description" | "category" | "bestFor" | "expectedData" | "page"> & {
  uses?: string[];
};

const GERMAN_STARTER_METADATA: Record<string, StarterLocalizedMetadata> = {
  invoice: {
    name: "Rechnung",
    description: "Professionelle Rechnungsvorlage mit Absender, Empfänger, Positionstabelle, Zahlungsbedingungen und Summenblock.",
    category: "Geschäftlich",
    bestFor: "Kundenrechnungen und Abrechnungsdatensätze.",
    expectedData:
      "Eine Zeile pro Rechnungsposition. Erwartete Aliasse: invoice_number, invoice_date, recipient_name, recipient_email, invoice_item, invoice_quantity, invoice_unit_price und invoice_line_total.",
    page: "A4 Hochformat",
  },
  "loan-agreement": {
    name: "Leihvertrag",
    description: "Geschäftsfertiger Leihvertrag mit Parteien, Gegenstandsliste, Bedingungen und Unterschriftsfeldern.",
    category: "Vertrag",
    bestFor: "Geräteleihen, Übergaben an Entleiher und unterzeichnete interne Vereinbarungen.",
    expectedData: "Ein Leihdatensatz sowie ausgewählte Angaben zu Entleiher, Zeitraum und Gegenständen.",
    page: "A4 Hochformat",
  },
  label: {
    name: "Etikett",
    description: "Betriebliches Etikett im Format 90 mm × 54 mm mit druckfertigem Code-128-Barcode.",
    category: "Etikett",
    bestFor: "Inventaretiketten, Regaletiketten und kompakte betriebliche Kennzeichnungen.",
    expectedData: "Ein ausgewählter Datensatz; die erste ausgewählte Spalte wird als Barcodewert verwendet.",
    page: "90 mm × 54 mm",
    uses: ["Code-128-Barcode"],
  },
  "qr-label": {
    name: "QR-Etikett",
    description: "Etikett im Format 90 mm × 54 mm mit großem QR-Code für Links, Inventar oder kompakte Datensatzdaten.",
    category: "Etikett",
    bestFor: "Inventarkennzeichnungen, Links, kompakte Kennungen und Scan-Workflows.",
    expectedData: "Ein ausgewählter Datensatz; die erste ausgewählte Spalte wird als QR-Wert verwendet.",
    page: "90 mm × 54 mm",
    uses: ["QR-Code"],
  },
  overview: {
    name: "Übersichtsbericht",
    description: "Mehrseitiger Geschäftsbericht über mehrere Datensätze.",
    category: "Bericht",
    bestFor: "Druckbare Listen, Exporte und interne Statusberichte.",
    expectedData: "Standardmäßig bis zu 100 Zeilen aus der Quelltabelle.",
    page: "A4 Hochformat",
  },
  "record-detail": {
    name: "Datensatzdetails",
    description: "Geschäftliches Detailblatt für einen Datensatz mit optionalem Bildkopf und vollbreiter Detailtabelle.",
    category: "Datensatz",
    bestFor: "Datensatzdossiers, Inventarblätter und Detailseiten für Kunden oder Konten.",
    expectedData: "Ein ausgewählter Datensatz; Bilddateifelder erscheinen als primaryImage/images.",
    page: "A4 Hochformat",
    uses: ["Datensatzbilder"],
  },
  "delivery-note": {
    name: "Lieferschein",
    description: "Lieferschein mit Absender, Empfänger, Lieferangaben und Positionstabelle.",
    category: "Logistik",
    bestFor: "Sendungen, Übergaben und Lieferbestätigungen.",
    expectedData: "Ein Lieferdatensatz sowie ausgewählte Liefer- und Positionsfelder.",
    page: "A4 Hochformat",
  },
  quote: {
    name: "Angebot",
    description: "Angebotsvorlage mit Kundenblock, Positionen, Gültigkeit und Geschäftsbedingungen.",
    category: "Geschäftlich",
    bestFor: "Angebote, Kostenschätzungen und geschäftliche Vorschläge.",
    expectedData: "Ein Angebotsdatensatz sowie ausgewählte Positionsfelder.",
    page: "A4 Hochformat",
  },
  "packing-list": {
    name: "Packliste",
    description: "Betriebliche Packliste mit echten gedruckten Kontrollkästchen und für mehrere Seiten geeigneten Zeilen.",
    category: "Betrieb",
    bestFor: "Kommissionierung, Verpackung, Vorbereitung und physische Checklisten.",
    expectedData: "Mehrere Zeilen aus der Quelltabelle.",
    page: "A4 Hochformat",
    uses: ["gedruckte Kontrollkästchen"],
  },
  certificate: {
    name: "Bescheinigung",
    description: "Formelle Bescheinigung oder Bestätigung für einen ausgewählten Datensatz.",
    category: "Formell",
    bestFor: "Bestätigungen, Bescheinigungen und unterzeichnete Nachweise.",
    expectedData: "Ein ausgewählter Datensatz.",
    page: "A4 Hochformat",
  },
  checklist: {
    name: "Checkliste",
    description: "Druckbare Checkliste mit echten Kontrollkästchen und Detailzeilen.",
    category: "Betrieb",
    bestFor: "Manuelle Prüfung, Einrichtung, Inspektion und wiederkehrende betriebliche Aufgaben.",
    expectedData: "Mehrere Zeilen aus der Quelltabelle.",
    page: "A4 Hochformat",
    uses: ["gedruckte Kontrollkästchen"],
  },
  badge: {
    name: "Namensschild",
    description: "Schlichtes professionelles Namensschild ohne interne Kennungen.",
    category: "Namensschild",
    bestFor: "Namensschilder, Veranstaltungsausweise und einfache Identitätskarten.",
    expectedData: "Ein ausgewählter Datensatz.",
    page: "85 mm × 55 mm",
  },
};

const GERMAN_DOCUMENT_COPY: ReadonlyArray<readonly [string, string]> = [
  ["Services and goods according to the itemized statement below.", "Leistungen und Waren gemäß der nachfolgenden Aufstellung."],
  ["Prepared for signature", "Zur Unterschrift vorbereitet"],
  ["Borrower initials", "Kürzel des Entleihers"],
  ["Report overview", "Berichtsübersicht"],
  ["Logistics", "Logistik"],
  ["Document Services", "Dokumentenservice"],
  ["Page ", "Seite "],
  ["Recipient not provided", "Empfänger nicht angegeben"],
  ["Issue date not provided", "Ausgabedatum nicht angegeben"],
  ["Commercial document", "Geschäftsdokument"],
  ["Invoice reference", "Rechnungsreferenz"],
  ["Payment terms", "Zahlungsbedingungen"],
  ["Due on receipt", "Sofort fällig"],
  ["Description", "Beschreibung"],
  ["Quantity", "Menge"],
  ["Unit price", "Einzelpreis"],
  ["Line total", "Positionssumme"],
  ["No invoice items were returned by the template query.", "Die Vorlagenabfrage hat keine Rechnungspositionen zurückgegeben."],
  ["Subtotal", "Zwischensumme"],
  ["Total due", "Gesamtbetrag"],
  ["Payment instructions", "Zahlungshinweise"],
  [
    "Please transfer the total amount{% if business.iban %} to the bank account stated in the footer{% endif %} and include the invoice number as payment reference.",
    "Bitte überweisen Sie den Gesamtbetrag{% if business.iban %} auf das im Fußbereich angegebene Bankkonto{% endif %} und geben Sie die Rechnungsnummer als Verwendungszweck an.",
  ],
  [
    "This invoice was generated from approved operational records. Please quote the invoice number on all payment references and correspondence.",
    "Diese Rechnung wurde aus freigegebenen Betriebsdaten erzeugt. Geben Sie die Rechnungsnummer bei Zahlungen und im Schriftverkehr an.",
  ],
  ["Notes", "Hinweise"],
  ["Currency", "Währung"],
  ["Invoice", "Rechnung"],
  ["Borrower organization", "Organisation des Entleihers"],
  ["Borrower name", "Name des Entleihers"],
  ["Internal loan document", "Internes Leihdokument"],
  ["Return required", "Rückgabe erforderlich"],
  ["Equipment loan agreement", "Geräteleihvertrag"],
  ["Agreement", "Vereinbarung"],
  ["Loan ref.", "Leihreferenz"],
  ["Lender", "Verleiher"],
  ["Represented by authorized staff.", "Vertreten durch autorisierte Mitarbeitende."],
  ["Borrower", "Entleiher"],
  ["Identification checked before handover.", "Identität vor der Übergabe geprüft."],
  ["Loan starts", "Leihbeginn"],
  ["Return due", "Rückgabe fällig"],
  ["Return condition", "Rückgabezustand"],
  ["To be agreed", "Noch zu vereinbaren"],
  ["As issued", "Wie ausgegeben"],
  ["Loaned equipment", "Ausgeliehene Gegenstände"],
  ["1. Handover and responsibility", "1. Übergabe und Verantwortung"],
  [
    "The borrower confirms receipt of the listed equipment in the condition documented at handover. The borrower is responsible for careful handling, secure storage, and timely return.",
    "Der Entleiher bestätigt den Erhalt der aufgeführten Gegenstände in dem bei der Übergabe dokumentierten Zustand. Er ist für sorgfältige Behandlung, sichere Aufbewahrung und fristgerechte Rückgabe verantwortlich.",
  ],
  ["2. Condition checklist", "2. Zustandsprüfung"],
  ["Equipment complete", "Gegenstände vollständig"],
  ["Accessories included", "Zubehör enthalten"],
  ["Visible damage documented", "Sichtbare Schäden dokumentiert"],
  ["Return date explained", "Rückgabedatum erläutert"],
  ["3. Loss, damage, and late return", "3. Verlust, Beschädigung und verspätete Rückgabe"],
  [
    "Loss, damage, missing accessories, or late return may be charged according to replacement value, repair cost, or the applicable internal policy.",
    "Verlust, Beschädigung, fehlendes Zubehör oder verspätete Rückgabe können nach Wiederbeschaffungswert, Reparaturkosten oder der geltenden internen Regelung berechnet werden.",
  ],
  ["Internal notes / handover initials", "Interne Hinweise / Kürzel bei Übergabe"],
  ["Place, date, lender signature", "Ort, Datum, Unterschrift des Verleihers"],
  ["Borrower initials", "Kürzel des Entleihers"],
  ["Place, date, borrower signature", "Ort, Datum, Unterschrift des Entleihers"],
  ["Scan for the selected record value.", "Scannen, um den Wert des ausgewählten Datensatzes aufzurufen."],
  ["Current GQL source", "Aktuelle GQL-Quelle"],
  ["Scope", "Umfang"],
  ["Rows", "Zeilen"],
  ["Report", "Bericht"],
  ["Record detail", "Datensatzdetails"],
  ["Source:", "Quelle:"],
  ["Delivery note", "Lieferschein"],
  ["Delivery no.", "Liefernummer"],
  ["Carrier", "Transport"],
  ["Internal delivery", "Interne Lieferung"],
  ["Ship from", "Versand von"],
  ["Ship to", "Lieferung an"],
  ["Recipient", "Empfänger"],
  ["Delivery address", "Lieferadresse"],
  ["Contact person", "Kontaktperson"],
  ["Delivered items", "Gelieferte Positionen"],
  ["Delivered by", "Übergeben von"],
  ["Received by", "Empfangen von"],
  ["Commercial offer", "Geschäftliches Angebot"],
  ["Quote no.", "Angebotsnummer"],
  ["Valid until", "Gültig bis"],
  ["30 days", "30 Tage"],
  ["Supplier", "Anbieter"],
  ["Customer Company", "Kundenunternehmen"],
  ["Customer address", "Kundenadresse"],
  ["Procurement contact", "Einkaufskontakt"],
  ["Customer", "Kunde"],
  ["Offer positions", "Angebotspositionen"],
  ["Terms", "Bedingungen"],
  [
    "Prices are net prices unless stated otherwise. Delivery, payment, and availability are subject to written confirmation.",
    "Sofern nicht anders angegeben, verstehen sich alle Preise netto. Lieferung, Zahlung und Verfügbarkeit bedürfen der schriftlichen Bestätigung.",
  ],
  ["Quote", "Angebot"],
  ["Warehouse", "Lager"],
  ["Packing list", "Packliste"],
  ["Prepared by", "Vorbereitet von"],
  ["Operations", "Betrieb"],
  ["Packed", "Verpackt"],
  ["Certificate", "Bescheinigung"],
  ["This document confirms the following record information.", "Dieses Dokument bestätigt die folgenden Datensatzangaben."],
  ["Place, date", "Ort, Datum"],
  ["Authorized signature", "Autorisierte Unterschrift"],
  ["Checklist", "Checkliste"],
  ["Owner", "Verantwortlich"],
  ["Items", "Einträge"],
  ["Done", "Erledigt"],
  ["Task", "Aufgabe"],
  ["Details", "Details"],
  ["Item", "Eintrag"],
];

const germanRenderer = (renderer: HtmlDocumentTemplateRenderer): HtmlDocumentTemplateRenderer => {
  const translate = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return GERMAN_DOCUMENT_COPY.reduce((copy, [english, german]) => copy.replaceAll(english, german), value);
  };
  return { ...renderer, body: translate(renderer.body)!, header: translate(renderer.header), footer: translate(renderer.footer) };
};

const isGermanLocale = (locale?: string): boolean => {
  try {
    return new Intl.Locale(locale ?? "en").language === "de";
  } catch {
    return false;
  }
};

export const getDocumentTemplateStarters = (locale?: string): DocumentTemplateStarter[] => {
  if (!isGermanLocale(locale)) return DOCUMENT_TEMPLATE_STARTERS;
  return DOCUMENT_TEMPLATE_STARTERS.map((starter) => ({
    ...starter,
    ...GERMAN_STARTER_METADATA[starter.id],
    renderer: germanRenderer(starter.renderer),
  }));
};

export const documentTemplateStarterById = (id: string, locale?: string): DocumentTemplateStarter | undefined =>
  getDocumentTemplateStarters(locale).find((starter) => starter.id === id);
