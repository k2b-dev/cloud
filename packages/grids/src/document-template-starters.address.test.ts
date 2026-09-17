import { describe, expect, test } from "bun:test";
import type { DocumentDefaults } from "./contracts";
import { documentTemplateStarterById } from "./document-template-starters";
import { buildRenderData, renderLiquidText } from "./service/documents";
import { defaultTemplateAppData, templateBusinessDataFromDefaults } from "./service/template-context";

const app = { ...defaultTemplateAppData(), name: "Cloud", url: "https://example.test" };

const addressCases: { defaults: DocumentDefaults; expected: string }[] = [
  {
    defaults: { address: "Main Street 1\nBuilding B", postalCode: "89073", city: "Ulm", countryCode: "DE" },
    expected: "Main Street 1\nBuilding B<br>89073 Ulm<br>DE",
  },
  { defaults: { address: "  Existing address\n89073 Ulm  " }, expected: "  Existing address\n89073 Ulm  " },
  { defaults: { postalCode: "89073", city: "Ulm", countryCode: "DE" }, expected: "89073 Ulm<br>DE" },
  { defaults: { city: "Ulm" }, expected: "Ulm" },
  { defaults: { postalCode: "89073" }, expected: "89073" },
  { defaults: { countryCode: "DE" }, expected: "DE" },
  { defaults: { address: "A & B <House>", city: "<City>" }, expected: "A &amp; B &lt;House&gt;<br>&lt;City&gt;" },
  { defaults: {}, expected: "" },
];

describe("document starter business addresses", () => {
  for (const locale of ["en", "de-DE"]) {
    test(`${locale}: all sender blocks render optional structured fields without changing existing address lines`, async () => {
      for (const id of ["invoice", "loan-agreement", "delivery-note", "quote"]) {
        const starter = documentTemplateStarterById(id, locale);
        if (!starter?.renderer.header) throw new Error(`Missing starter/header: ${id}`);
        for (const { defaults, expected } of addressCases) {
          const data = buildRenderData({
            app,
            business: templateBusinessDataFromDefaults(defaults),
            rows: [],
            columns: [],
            table: { id: "table-1", shortId: "Tbl001", name: "Items" },
            record: {
              id: "record-1",
              shortId: "Rec001",
              tableId: "table-1",
              version: 1,
              data: {},
              createdAt: "2026-09-17T12:00:00Z",
              updatedAt: "2026-09-17T12:00:00Z",
            },
            documentNumber: "DOC-1",
            createdAt: "2026-09-17T12:00:00Z",
          });
          const body = await renderLiquidText(starter.renderer.body, data);
          if (!body.ok) throw new Error(`${id}: ${body.error.message}`);
          expect(body.data, id).toContain(`<p class="preline">${expected}</p>`);
          const header = await renderLiquidText(starter.renderer.header, data);
          if (!header.ok) throw new Error(`${id} header: ${header.error.message}`);
          expect(header.data, id).toContain(`<div class="line">${expected || "https:&#x2F;&#x2F;example.test"}</div>`);
        }
      }
    });
  }

  test("keeps an explicit sender line as header fallback when no address is configured", async () => {
    const starter = documentTemplateStarterById("invoice");
    if (!starter?.renderer.header) throw new Error("Missing invoice header");
    const rendered = await renderLiquidText(starter.renderer.header, {
      app,
      business: templateBusinessDataFromDefaults({ senderLine: "Office & desk" }),
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    expect(rendered.data).toContain('<div class="line">Office &amp; desk</div>');
  });
});
