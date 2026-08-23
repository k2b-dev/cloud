import { describe, expect, test } from "bun:test";
import { DOCUMENT_TEMPLATE_STARTERS } from "../document-template-starters";
import {
  buildRenderData,
  buildTemplateAppData,
  buildTemplateInputContext,
  documentNumberFor,
  documentRecordDataWithPublicIds,
  publicDocumentLinkUrlForAppUrl,
  renderDocumentHtml,
  renderDocumentProfileInput,
  renderDocumentSource,
  renderLiquidText,
  rowsWithColumnLabels,
  validateLiquidTemplate,
  validateTemplateWrite,
} from "./documents";

describe("document rendering", () => {
  test("exposes record fields and relation values through public IDs", () => {
    expect(
      documentRecordDataWithPublicIds(
        { "field-name-uuid": "Ada", "field-relation-uuid": ["record-uuid", "unreadable-record-uuid"] },
        [
          { id: "field-name-uuid", shortId: "NAME01", type: "text" },
          { id: "field-relation-uuid", shortId: "REL001", type: "relation" },
        ] as never,
        new Map([["record-uuid", "REC001"]]),
      ),
    ).toEqual({ NAME01: "Ada", REL001: ["REC001", null] });
  });

  test("renders profile input as exact JSON without confusing values with JSON syntax", async () => {
    const rendered = await renderDocumentProfileInput(
      { renderer: { kind: "profile", id: "test.invoice", version: 1, inputTemplate: '{"customer": {{ record.data.customer | json }}}' } },
      { record: { data: { customer: 'A & B "quoted"' } } },
    );
    expect(rendered).toEqual({ ok: true, data: { customer: 'A & B "quoted"' } });
  });

  test("exposes stable public app data to document templates", async () => {
    const app = await buildTemplateAppData({
      app: {
        name: "Operations Cloud",
        url: "cloud.example.test",
        contact_email: "support@example.test",
        copyright: "Example GmbH",
        timezone: "Europe/Berlin",
        logo: "data:image/png;base64,abc",
      },
    });

    expect(app).toMatchObject({
      name: "Operations Cloud",
      url: "https://cloud.example.test",
      contactEmail: "support@example.test",
      copyright: "Example GmbH",
      timezone: "Europe/Berlin",
      logoDataUri: "data:image/png;base64,abc",
    });

    const table = { id: "table-1", shortId: "tbl1", name: "Items" };
    const record = {
      id: "record-1",
      shortId: "rec001",
      tableId: "table-1",
      version: 1,
      data: { name: "Camera" },
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };

    expect(buildTemplateInputContext(record, table, app).app).toEqual(app);
    expect(buildRenderData({ record, table, columns: [], rows: [], app }).app).toEqual(app);
  });

  test("builds public document links from configured app urls", () => {
    expect(publicDocumentLinkUrlForAppUrl("https://cloud.example.test/", "gdl_publicToken")).toBe(
      "https://cloud.example.test/share/grids/documents/gdl_publicToken",
    );
    expect(publicDocumentLinkUrlForAppUrl("cloud.example.test", "gdl_token/with/slashes")).toBe(
      "https://cloud.example.test/share/grids/documents/gdl_token%2Fwith%2Fslashes",
    );
    expect(publicDocumentLinkUrlForAppUrl("", "gdl_defaultToken")).toBe("http://localhost:3000/share/grids/documents/gdl_defaultToken");
    expect(publicDocumentLinkUrlForAppUrl("localhost:3000", "gdl_localToken")).toBe(
      "http://localhost:3000/share/grids/documents/gdl_localToken",
    );
    expect(publicDocumentLinkUrlForAppUrl("https://localhost:3000", "gdl_explicitTlsToken")).toBe(
      "https://localhost:3000/share/grids/documents/gdl_explicitTlsToken",
    );
  });

  test("exposes Base document defaults as business data to document templates", () => {
    const table = { id: "table-1", shortId: "tbl1", name: "Items" };
    const record = {
      id: "record-1",
      shortId: "rec001",
      tableId: "table-1",
      version: 1,
      data: { name: "Camera" },
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const app = {
      name: "Cloud",
      url: "https://cloud.example.test",
      contactEmail: "support@example.test",
      copyright: null,
      timezone: "Europe/Berlin",
      logoDataUri: "data:image/svg+xml,abc",
    };
    const business = {
      legalName: "Operations GmbH",
      senderLine: "Operations GmbH | Berlin",
      address: "Main Street 1\n10117 Berlin",
      department: "Finance",
      contactEmail: "finance@example.test",
      phone: "+49 30 123",
      url: "https://example.test",
      taxId: "VAT DE123",
      registration: "HRB 123",
      bankName: "Example Bank",
      iban: "DE00 0000 0000 0000 0000 00",
      bic: "EXAMPLEXXX",
      paymentTerms: "14 days net",
      footerText: "Operations GmbH | HRB 123",
    };

    expect(buildTemplateInputContext(record, table, app, business).business).toEqual(business);
    expect(buildRenderData({ record, table, columns: [], rows: [], app, business }).business).toEqual(business);
  });

  test("exposes record scan metadata outside record data", () => {
    const table = { id: "table-1", shortId: "tbl1", name: "Items" };
    const record = {
      id: "record-1",
      shortId: "rec001",
      tableId: "table-1",
      version: 1,
      data: { name: "Camera" },
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const meta = {
      scan: {
        code: "gsc_test",
        qrText: "gsc_test",
      },
    };

    const input = buildTemplateInputContext(record, table, undefined, undefined, undefined, undefined, undefined, meta);
    const render = buildRenderData({ record, table, columns: [], rows: [], recordMeta: meta });

    expect(input.record).toMatchObject({ id: "rec001", tableId: "tbl1", data: { name: "Camera" }, meta });
    expect(render.record).toMatchObject({ id: "record-1", data: { name: "Camera" }, meta });
    expect((input.record as { data: Record<string, unknown> }).data).not.toHaveProperty("scan");
  });

  test("renders Liquid templates with escaped output by default", async () => {
    const result = await renderDocumentHtml(
      {
        renderer: {
          kind: "html",
          body: "<p>{{ record.data.name }}</p>",
          numberTemplate: "DOC-{{ series.value }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      { record: { data: { name: "<b>Ada</b>" } } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("<p>&lt;b&gt;Ada&lt;&#x2F;b&gt;</p>");
  });

  test("allows explicit raw output for trusted template authors", async () => {
    const result = await renderLiquidText("{{ value | raw }}", { value: "<strong>OK</strong>" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("<strong>OK</strong>");
  });

  test("renders barcode data URLs through the document Liquid filter", async () => {
    const result = await renderLiquidText(`<img src="{{ value | barcode_data_url: "code128", true }}">`, { value: "ITEM-0001" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("data:image&#x2F;svg+xml;base64,");
  });

  test("exposes document images in render data", () => {
    const table = { id: "table-1", shortId: "tbl1", name: "Items" };
    const record = {
      id: "record-1",
      shortId: "rec001",
      tableId: "table-1",
      version: 1,
      data: {},
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const image = {
      fieldId: "field-1",
      fieldName: "Photo",
      fileId: "file-1",
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 42,
      url: "data:image/png;base64,abc",
    };

    const data = buildRenderData({ record, table, columns: [], rows: [], images: [image] });

    expect(data.images).toEqual([image]);
    expect(data.primaryImage).toEqual(image);
  });

  test("reports invalid barcode filters as template errors", async () => {
    const result = await renderLiquidText(`{{ value | barcode_data_url: "Code 128" }}`, { value: "ITEM-0001" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('invalid barcode type "Code 128"');
  });

  test("rejects partial-style tags that could load external template content", () => {
    const result = validateLiquidTemplate("{% include 'other' %}");

    expect(result.ok).toBe(false);
  });

  test("all document template starters use valid Liquid", () => {
    for (const starter of DOCUMENT_TEMPLATE_STARTERS) {
      const parts = [
        ["source", starter.source("11111111-1111-4111-8111-111111111111")],
        ["numberTemplate", starter.renderer.numberTemplate],
        ["filenameTemplate", starter.renderer.filenameTemplate],
        ["body", starter.renderer.body],
        ["header", starter.renderer.header],
        ["footer", starter.renderer.footer],
        ["css", starter.renderer.css],
      ] as const;

      for (const [part, value] of parts) {
        if (!value) continue;
        const result = validateLiquidTemplate(value);
        expect(result.ok, `${starter.id} ${part}: ${result.ok ? "" : result.error.message}`).toBe(true);
      }

      const writeResult = validateTemplateWrite({
        source: starter.source("11111111-1111-4111-8111-111111111111"),
        renderer: starter.renderer,
      });
      expect(writeResult.ok, `${starter.id} write: ${writeResult.ok ? "" : writeResult.error.message}`).toBe(true);
    }
  });

  test("all document template starters render with present and empty query rows", async () => {
    const table = { id: "11111111-1111-4111-8111-111111111111", shortId: "tbl11", name: "Assets" };
    const record = {
      id: "22222222-2222-4222-8222-222222222222",
      shortId: "rec222",
      tableId: table.id,
      version: 1,
      data: { Name: "Camera kit" },
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const columns = [
      { key: "name", label: "Name" },
      { key: "status", label: "Status" },
    ];
    const rows = [{ recordId: record.id, tableId: table.id, name: "Camera kit", Name: "Camera kit", status: "Ready", Status: "Ready" }];
    const image = {
      fieldId: "33333333-3333-4333-8333-333333333333",
      fieldName: "Photo",
      fileId: "file-1",
      filename: "camera.png",
      mimeType: "image/png",
      sizeBytes: 42,
      url: "data:image/png;base64,abc",
    };
    const business = {
      legalName: "Operations GmbH",
      senderLine: "Operations GmbH | Berlin",
      address: "Main Street 1\n10117 Berlin",
      department: "Operations",
      contactEmail: "ops@example.test",
      phone: "+49 30 123",
      url: "https://operations.example.test",
      taxId: "VAT DE123",
      registration: "HRB 123",
      bankName: "Example Bank",
      iban: "DE00 0000 0000 0000 0000 00",
      bic: "EXAMPLEXXX",
      paymentTerms: "14 days net",
      footerText: "Operations GmbH",
    };
    const filledData = buildRenderData({
      record,
      table,
      columns,
      rows,
      images: [image],
      business,
      documentNumber: "tplA1-20260628-runB2",
      createdAt: "2026-06-28T12:00:00.000Z",
    });
    const emptyData = buildRenderData({ record, table, columns: [], rows: [], business });

    for (const starter of DOCUMENT_TEMPLATE_STARTERS) {
      for (const data of [filledData, emptyData]) {
        const html = await renderDocumentHtml({ renderer: starter.renderer }, data);
        expect(html.ok, `${starter.id} html: ${html.ok ? "" : html.error.message}`).toBe(true);

        if (starter.renderer.header) {
          const header = await renderLiquidText(starter.renderer.header, data);
          expect(header.ok, `${starter.id} header: ${header.ok ? "" : header.error.message}`).toBe(true);
        }
        if (starter.renderer.footer) {
          const footer = await renderLiquidText(starter.renderer.footer, data);
          expect(footer.ok, `${starter.id} footer: ${footer.ok ? "" : footer.error.message}`).toBe(true);
        }
      }
    }
  });

  test("document template starters render business profile branding", async () => {
    const app = await buildTemplateAppData({
      app: {
        name: "Operations Cloud",
        url: "https://cloud.example.test",
        contact_email: "support@example.test",
        logo: "data:image/png;base64,abc",
      },
    });
    const invoice = DOCUMENT_TEMPLATE_STARTERS.find((starter) => starter.id === "invoice");
    expect(invoice?.renderer.header).toBeTruthy();
    if (!invoice?.renderer.header) throw new Error("invoice starter header is missing");

    const result = await renderLiquidText(invoice.renderer.header, {
      app,
      business: {
        legalName: "Operations GmbH",
        senderLine: "Operations GmbH | Main Street 1 | 10117 Berlin",
        address: "Main Street 1\n10117 Berlin",
        department: "Finance",
        contactEmail: "finance@example.test",
        phone: "+49 30 123",
        url: "https://operations.example.test",
        taxId: null,
        registration: null,
        bankName: null,
        iban: null,
        bic: null,
        paymentTerms: null,
        footerText: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("Operations GmbH");
      expect(result.data).toContain("finance@example.test");
      expect(result.data).toContain("data:image&#x2F;png;base64,abc");
    }
  });

  test("invoice starter renders customer, multiple items, and calculated totals", async () => {
    const invoice = DOCUMENT_TEMPLATE_STARTERS.find((starter) => starter.id === "invoice");
    expect(invoice).toBeDefined();
    if (!invoice) return;

    const rendered = await renderDocumentHtml(
      { renderer: invoice.renderer },
      {
        app: { name: "Example Cloud" },
        business: {
          legalName: "Example Books GmbH",
          senderLine: "Example Books GmbH",
          address: "Book Street 1\n10117 Berlin",
          contactEmail: "billing@example.test",
          phone: "+49 30 123",
          url: "https://books.example.test",
          paymentTerms: "14 days net",
          iban: null,
        },
        document: { number: "DOC-2026-0042", createdAt: "2026-07-17" },
        rows: [
          {
            invoice_number: "ORD-2026-0042",
            invoice_date: "2026-07-16",
            recipient_name: "Ada Lovelace",
            recipient_email: "ada@example.test",
            invoice_item: "The Hobbit",
            invoice_quantity: 2,
            invoice_unit_price: 9.99,
            invoice_line_total: 19.98,
          },
          {
            invoice_number: "ORD-2026-0042",
            invoice_date: "2026-07-16",
            recipient_name: "Ada Lovelace",
            recipient_email: "ada@example.test",
            invoice_item: "The Left Hand of Darkness",
            invoice_quantity: 1,
            invoice_unit_price: 11.99,
            invoice_line_total: 11.99,
          },
        ],
        columns: [
          { key: "invoice_number", label: "Invoice number" },
          { key: "invoice_date", label: "Invoice date" },
          { key: "recipient_name", label: "Recipient" },
          { key: "recipient_email", label: "Email" },
          { key: "invoice_item", label: "Item" },
          { key: "invoice_quantity", label: "Quantity" },
          { key: "invoice_unit_price", label: "Unit price" },
          { key: "invoice_line_total", label: "Line total" },
        ],
      },
    );

    expect(rendered.ok, rendered.ok ? "" : rendered.error.message).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.data).toContain("Ada Lovelace");
    expect(rendered.data).toContain("The Hobbit");
    expect(rendered.data).toContain("The Left Hand of Darkness");
    expect(rendered.data).toContain("31.97 EUR");
    expect(rendered.data).not.toContain("Customer Company");
  });

  test("renders GQL source templates with the same constrained Liquid context", async () => {
    const result = await renderDocumentSource(
      { source: "from table Invoices\nwhere record.id = '{{ record.id }}'" },
      { record: { id: "11111111-1111-4111-8111-111111111111" } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("11111111-1111-4111-8111-111111111111");
  });

  test("uses public resource ids when Liquid binds the current record into GQL", async () => {
    const context = buildTemplateInputContext(
      {
        id: "11111111-1111-4111-8111-111111111111",
        shortId: "REC001",
        tableId: "22222222-2222-4222-8222-222222222222",
        version: 1,
        data: {},
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
      { id: "22222222-2222-4222-8222-222222222222", shortId: "TAB001", name: "Loans" },
    );
    const result = await renderDocumentSource({ source: "where Loan = '{{ record.id }}'" }, context);

    expect(context.record).toMatchObject({ id: "REC001", tableId: "TAB001" });
    expect(result).toEqual({ ok: true, data: "where Loan = 'REC001'" });
  });

  test("document number is stable for a Document and uses the template pattern", () => {
    expect(
      documentNumberFor({
        template: {
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "tplA1",
          name: "Invoice",
          numberTemplate: "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
        },
        documentShortId: "runB2",
        createdAt: new Date("2026-06-26T12:00:00.000Z"),
      }),
    ).toEqual({ ok: true, data: "tplA1-20260626-runB2" });
  });

  test("document number date uses the configured time zone", () => {
    expect(
      documentNumberFor({
        template: {
          shortId: "tplA1",
          name: "Invoice",
          numberTemplate: "{{ date.yyyyMMdd }}",
        },
        documentShortId: "runB2",
        createdAt: new Date("2026-06-26T22:30:00.000Z"),
        dateConfig: { timeZone: "Europe/Berlin" },
      }),
    ).toEqual({ ok: true, data: "20260627" });
  });

  test("document pattern validation accepts Liquid loop built-ins and modifiers", () => {
    const result = validateTemplateWrite({
      source: "from table Items\nwhere record.id = '{{ record.id }}'",
      renderer: {
        kind: "html",
        body: "{% for row in rows reversed %}<p>{{ forloop.index }} {{ row.Name }}</p>{% endfor %}",
        numberTemplate: "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
        filenameTemplate: "{{ document.number }}.pdf",
      },
    });

    expect(result.ok).toBe(true);
  });

  test("document pattern validation rejects loop locals outside their loop", () => {
    const result = validateTemplateWrite({
      source: "from table Items\nwhere record.id = '{{ record.id }}'",
      renderer: {
        kind: "html",
        body: "{% for row in rows %}<p>{{ row.Name }}</p>{% endfor %}<p>{{ row.Name }}</p>",
        numberTemplate: "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
        filenameTemplate: "{{ document.number }}.pdf",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('HTML template uses unknown Liquid variable "row"');
  });

  test("document pattern validation rejects unknown variables", () => {
    const result = validateTemplateWrite({
      source: "from table Items\nwhere record.id = '{{ record.id }}'",
      renderer: {
        kind: "html",
        body: "<p>{{ record.id }}</p>",
        numberTemplate: "{{ records.name }}-{{ document.id }}",
        filenameTemplate: "{{ document.number }}.pdf",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('document number pattern uses unknown Liquid variable "records"');
  });

  test("filename pattern validation rejects unknown variables", () => {
    const result = validateTemplateWrite({
      source: "from table Items\nwhere record.id = '{{ record.id }}'",
      renderer: {
        kind: "html",
        body: "<p>{{ record.id }}</p>",
        numberTemplate: "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
        filenameTemplate: "{{ documents.number }}.pdf",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('filename template uses unknown Liquid variable "documents"');
  });

  test("rows expose GQL output labels for ergonomic Liquid templates", () => {
    expect(rowsWithColumnLabels([{ key: "field_id", label: "Name" }], [{ field_id: "Sony A7 body" }])).toEqual([
      { field_id: "Sony A7 body", Name: "Sony A7 body" },
    ]);
  });
});
