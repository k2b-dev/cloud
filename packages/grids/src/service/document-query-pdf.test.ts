import { expect, spyOn, test } from "bun:test";
import { validateDocumentQueryOutput } from "./document-query-output";
import { renderDocumentHtmlPdf, renderDocumentPdfPreview } from "./document-rendering";

test("query PDFs render multiple rows and nested items through the shared bounded renderer", async () => {
  const files = new Map<string, string>();
  const output = {
    kind: "pdf",
    body: "<html><head></head><body>{% for row in rows %}<h2>{{ row.name }}</h2>{% for item in row.items %}<p>{{ item.amount }}</p>{% endfor %}{% endfor %}</body></html>",
    header: "<span>{{ document.number }}</span>",
    footer: "<span>Report</span>",
    css: "thead { display: table-header-group; } h2 { break-before: page; }",
  };
  expect(validateDocumentQueryOutput(output).ok).toBe(true);
  const rendered = await renderDocumentHtmlPdf(
    {
      content: output,
      data: {
        rows: [
          { name: "<First>", items: [{ amount: "12.30" }] },
          { name: "Second", items: [{ amount: "42.00" }] },
        ],
        columns: [],
        document: { number: "PDF-1" },
      },
      filename: "report.pdf",
    },
    "en",
    {
      config: { url: "http://renderer.invalid", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 },
      fetch: async (_url, init) => {
        if (!(init?.body instanceof FormData)) throw new Error("Expected PDF form data");
        for (const value of init.body.getAll("files")) {
          if (value instanceof File) files.set(value.name, await value.text());
        }
        return new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } });
      },
    },
  );
  expect(rendered.ok).toBe(true);
  expect(files.get("index.html")).toContain("<h2>&lt;First&gt;</h2><p>12.30</p><h2>Second</h2><p>42.00</p>");
  expect(files.get("index.html")).toContain("break-before: page");
  expect(files.get("header.html")).toEndWith("<span>PDF-1</span>");
  expect(files.get("footer.html")).toEndWith("<span>Report</span>");
});

test("query PDF template contracts reject unavailable record roots and malformed Liquid", () => {
  for (const body of ["{{ record.name }}", "{{ app.secret }}", "{% for row in rows %}"]) {
    expect(validateDocumentQueryOutput({ kind: "pdf", body }).ok).toBe(false);
  }
  expect(validateDocumentQueryOutput({ kind: "pdf", body: "<p>Report</p>", numberTemplate: "custom" }).ok).toBe(false);
});

test("authors can group sorted flat join rows into PDF sections without losing line items", async () => {
  const body =
    '{% assign previous = "" %}{% for row in rows %}{% if row.expense != previous %}<h2>{{ row.expense }}</h2>{% assign previous = row.expense %}{% endif %}<p>{{ row.item }}: {{ row.amount }}</p>{% endfor %}';
  expect(validateDocumentQueryOutput({ kind: "pdf", body }).ok).toBe(true);
  let html = "";
  const result = await renderDocumentHtmlPdf(
    {
      content: { body },
      filename: "grouped.pdf",
      data: {
        rows: [
          { expense: "Expense A", item: "Train", amount: "12.30" },
          { expense: "Expense A", item: "Hotel", amount: "42.00" },
          { expense: "Expense B", item: "Ticket <2>", amount: "5.00" },
        ],
        columns: [],
        document: { number: "GROUP-1" },
      },
    },
    "en",
    {
      config: { url: "http://renderer.invalid", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 },
      fetch: async (_url, init) => {
        if (!(init?.body instanceof FormData)) throw new Error("Expected PDF form data");
        for (const file of init.body.getAll("files")) if (file instanceof File && file.name === "index.html") html = await file.text();
        return new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } });
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(html.match(/<h2>/g)).toHaveLength(2);
  expect(html).toContain("<h2>Expense A</h2><p>Train: 12.30</p><p>Hotel: 42.00</p><h2>Expense B</h2><p>Ticket &lt;2&gt;: 5.00</p>");
});

test("a missing PDF renderer tells users that an administrator configures it", async () => {
  using warn = spyOn(console, "warn").mockImplementation(() => {});
  const config = { url: "", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 };
  const document = await renderDocumentHtmlPdf({ content: { body: "<p>Report</p>" }, data: {}, filename: "report.pdf" }, "de", { config });
  expect(document.ok).toBe(false);
  if (!document.ok) {
    expect(document.error.code).toBe("BAD_INPUT");
    expect(document.error.message).toStartWith("Die PDF-Erstellung ist nicht eingerichtet.");
  }

  const preview = await renderDocumentPdfPreview(
    { renderer: { kind: "html", body: "<p>Report</p>", numberTemplate: "", filenameTemplate: "" } },
    {},
    "report.pdf",
    config,
    "en",
  );
  expect(preview).toMatchObject({
    ok: false,
    error: { phase: "pdf", code: "not_configured", status: 400, message: expect.stringContaining("PDF rendering is not configured.") },
  });
  expect(warn).toHaveBeenCalledWith(
    "[grids:documents]",
    "Document PDF rendering failed",
    expect.objectContaining({ code: "not_configured" }),
  );
});

test("other renderer failures keep the generic message", async () => {
  using _warn = spyOn(console, "warn").mockImplementation(() => {});
  const config = { url: "http://renderer.invalid", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 };
  const document = await renderDocumentHtmlPdf({ content: { body: "<p>Report</p>" }, data: {}, filename: "report.pdf" }, "en", {
    config,
    fetch: async () => new Response("down", { status: 503 }),
  });
  expect(document.ok).toBe(false);
  if (!document.ok) expect(document.error.message).toBe("PDF rendering failed.");
});
