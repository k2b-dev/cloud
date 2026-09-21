import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { renderDocumentHtmlPdf } from "./document-rendering";

// Explicit infrastructure test: requires Gotenberg and Poppler's pdftotext.
// Keep the optional review directory to inspect the actual paginated output.
const pdftotext = Bun.which(process.env.PDFTOTEXT ?? "pdftotext");
const renderTest = pdftotext ? testFor("gotenberg") : test.skip;
const skipReason = pdftotext ? "" : " (skipped: Poppler pdftotext is not on PATH; install Poppler or set PDFTOTEXT)";
renderTest(
  `real Gotenberg renders multiple records, long nested items, repeated headers and an empty selection${skipReason}`,
  async () => {
    if (!pdftotext || !testInfra.gotenberg) throw new Error("Gotenberg and pdftotext are required");
    const directory = process.env.GRIDS_PDF_REVIEW_DIR ?? (await mkdtemp(join(tmpdir(), "grids-query-pdf-")));
    try {
      for (const empty of [false, true]) {
        const rows = empty
          ? []
          : Array.from({ length: 3 }, (_, record) => ({
              title: `Expense ${record + 1} - Müller & Partner <review>`,
              items: Array.from({ length: 45 }, (_, item) => ({
                description: `Position ${record + 1}.${item + 1} - Reisekosten`,
                amount: "12.30",
              })),
            }));
        const result = await renderDocumentHtmlPdf(
          {
            filename: "expenses.pdf",
            data: { rows, columns: [], document: { number: "REPORT-1" } },
            content: {
              body: '<html><head><meta charset="utf-8"></head><body><h1>Expense overview</h1>{% if rows.size == 0 %}<p>No expenses selected.</p>{% endif %}{% for row in rows %}<section><h2>{{ row.title }}</h2><table><thead><tr><th>Description</th><th>Amount EUR</th></tr></thead><tbody>{% for item in row.items %}<tr><td>{{ item.description }}</td><td>{{ item.amount }}</td></tr>{% endfor %}</tbody></table></section>{% endfor %}</body></html>',
              css: "body { font: 12px sans-serif; color: #202124; } section + section { break-before: page; } h2 { break-after: avoid; } table { border-collapse: collapse; width: 100%; } thead { display: table-header-group; } th { text-align: left; } th:last-child, td:last-child { text-align: right; } th, td { padding: 8px; border-bottom: 1px solid #e5e7eb; } tr { break-inside: avoid; }",
              footer:
                '<div style="font: 9px sans-serif; text-align: center; width: 100%">REPORT-1 - <span class="pageNumber"></span></div>',
            },
          },
          "en",
          { config: { url: testInfra.gotenberg, timeoutMs: 30_000, maxHtmlBytes: 1_000_000, maxPdfBytes: 10_000_000 } },
        );
        if (!result.ok) throw result.error;
        const path = join(directory, empty ? "empty.pdf" : "multi-record.pdf");
        await Bun.write(path, result.data.pdf);
        const extraction = Bun.spawn([pdftotext, "-layout", path, "-"], { stdout: "pipe", stderr: "pipe" });
        const text = await new Response(extraction.stdout).text();
        const error = await new Response(extraction.stderr).text();
        expect(await extraction.exited, error).toBe(0);
        expect(text).toContain("Expense overview");
        if (empty) {
          expect(text).toContain("No expenses selected.");
        } else {
          const pages = text.split("\f").filter((page) => page.trim());
          expect(pages.length).toBeGreaterThanOrEqual(6);
          for (const page of pages) expect(page).toContain("Description");
          for (let record = 1; record <= 3; record++) {
            expect(text).toContain(`Expense ${record} - Müller & Partner <review>`);
            for (let item = 1; item <= 45; item++) expect(text).toContain(`Position ${record}.${item} - Reisekosten`);
          }
          expect((text.match(/12\.30/g) ?? []).length).toBe(135);
        }
      }
      if (process.env.GRIDS_PDF_REVIEW_DIR) console.info(`PDF review files: ${directory}`);
    } finally {
      if (!process.env.GRIDS_PDF_REVIEW_DIR) await rm(directory, { recursive: true });
    }
  },
  90_000,
);
