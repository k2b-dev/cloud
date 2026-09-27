import { expect } from "bun:test";
import { einvoice } from "@k2b/stdlib/finance";
import { PDFDocument } from "pdf-lib";
import { probeDocument, probeTemplate, startGotenbergTrap } from "../../../../scripts/fixtures/gotenberg-trap";
import { requireInfraUrl, testFor } from "../../../../scripts/fixtures/test-infra";
import { executePdf } from "./pdf-service";
import { invoice } from "./test-invoice";

testFor("gotenberg")(
  "real Gotenberg renders offline HTML and roundtrips Factur-X and XML attachments",
  async () => {
    const config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
    const trap = await startGotenbergTrap(config.url);
    try {
      const document = probeDocument(trap.origin, "code-mode");
      const html = {
        html: document.html,
        headerHtml: probeTemplate(trap.origin, "header"),
        footerHtml: probeTemplate(trap.origin, "footer"),
      };
      const unfiltered = await PDFDocument.load(await trap.renderUnfiltered(html));
      expect(await trap.takeRequests()).toEqual(expect.arrayContaining(document.paths));
      expect(unfiltered.getPageCount()).toBe(3);

      const output = await executePdf({ operation: "render", ...html, page: { format: "A5" } }, config);
      expect(await trap.takeRequests()).toEqual([]);
      const parsed = await PDFDocument.load(output.pdf);
      expect(parsed.getPages()).toHaveLength(1);
      expect(parsed.getPages()[0]!.getWidth()).toBeCloseTo((148 / 25.4) * 72, 0);
      const xml = einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" });
      if (!xml.ok) throw new Error(JSON.stringify(xml));
      const invoicePdf = await executePdf(
        { operation: "facturX", html: "<h1>Invoice TEST-42</h1>", xml: xml.data.xml, profile: "EN 16931" },
        config,
      );
      const result = await einvoice.parsePdf(invoicePdf.pdf);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.invoice.number).toBe("TEST-42");
      const attached = await executePdf(
        {
          operation: "attach",
          document: new Blob([new Uint8Array(output.pdf)]),
          attachments: [{ name: "factur-x.xml", data: new Blob([xml.data.xml], { type: "application/xml" }), relationship: "Alternative" }],
        },
        config,
      );
      expect((await einvoice.parsePdf(attached.pdf)).ok).toBe(true);
    } finally {
      await trap.stop();
    }
  },
  60000,
);
