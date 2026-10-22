import { expect, test } from "bun:test";
import { geoMapSnapshotFingerprint, geoMapSnapshotPart } from "@k2b/cloud/contracts/geo-snapshot";
import { prepareGeoMapSnapshotAssets, renderHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { startGotenbergTrap } from "../../../../../scripts/fixtures/gotenberg-trap";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";

suiteFor("gotenberg")("map snapshot offline PDF assets", () => {
  test("a decoded upload survives offline HTML conversion as an image with linked attribution", async () => {
    // This fixture tests upload/decoder/PDF transport. The MapView browser suite proves vector basemap pixels.
    const data = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#f1efe9" } })
      .png()
      .toBuffer();
    const fingerprint = await geoMapSnapshotFingerprint({ version: 1, title: "Saved fixture", pins: [] });
    const maps = [{ id: "block-1", fingerprint }];
    const form = new FormData();
    form.set("mapSnapshots", JSON.stringify({ version: 1, revision: "revision-17", images: [{ ...maps[0], width: 200, height: 100 }] }));
    form.set(geoMapSnapshotPart("block-1"), new Blob([data], { type: "image/png" }));
    const assets = await prepareGeoMapSnapshotAssets(form, { revision: "revision-17", maps, maxBytes: 1024 * 1024 });
    const url = requireInfraUrl("gotenberg");
    const trap = await startGotenbergTrap(url);
    try {
      const { pdf } = await renderHtmlToPdfWithConfig(
        {
          html: `<!doctype html><html><body><img src="${assets[0]!.name}" width="200" height="100"><p>Saved map sources · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · © OpenMapTiles · Geoapify</p></body></html>`,
          assets,
        },
        { url, timeoutMs: 30_000, maxHtmlBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024 },
      );
      expect(await trap.takeRequests()).toEqual([]);
      const loading = getDocument({ data: pdf.slice() });
      try {
        const document = await loading.promise;
        const page = await document.getPage(1);
        const operators = await page.getOperatorList();
        expect(operators.fnArray.filter((operator) => operator === OPS.paintImageXObject)).toHaveLength(1);
        const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ");
        expect(text).toContain("Saved map sources");
        expect(text).toContain("OpenStreetMap");
        expect(text).toContain("Geoapify");
        const annotations = await page.getAnnotations();
        expect(annotations.some((annotation) => annotation.url === "https://www.openstreetmap.org/copyright")).toBe(true);
      } finally {
        await loading.destroy();
      }
    } finally {
      await trap.stop();
    }
  }, 60_000);
});
