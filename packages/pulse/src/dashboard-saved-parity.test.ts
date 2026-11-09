import { expect, test } from "bun:test";
import { drawChart } from "@k2b/editor/charts";
import { DashboardPanelSchema } from "./dashboard-contracts";
import { dashboardChartRenderOptions } from "./dashboard-description";
import { savedChartFixtures } from "./dashboard-saved.test-fixture";

// Captured from origin/main d83535a03f with these same SQL fixtures, locale and renderer.
// New catalog mappings must not change a saved panel's SVG bytes.
const savedSvg = {
  line: "20f77bf3b7c35a26542f59d685c17bbd986ccaedfd9a7db1df1eb8062a132bc5",
  bar: "1e8855228b94f82db7114fe2a4561d6bb36f80dbab0da448a7a338801fae9830",
  funnel: "a00dd98f9ecd9f51d9ac5d9b00cb36686dbb1675ba199f8d06bc2820507b94bf",
  pie: "f1e571e93042d0a7e02667dd1b36ae4d83a6a77f4e5f78e3fee8a2b370cb8a1a",
  donut: "1af81a98fec90798e52906c959416075171aa6aa3e0434331450fcab582a638c",
  barGauge: "850946095e0b0b360ee897fd4404ded1625624037bcb4043b32814f827303417",
  histogram: "9708485160efcd91e6f150d5180467891f45559522110d620ed02ba0acc46031",
  sparkline: "08297ac01ad0db324ec801f4cb9e7e4d294fed87521375cb29c5d30d3a605871",
  gauge: "aba9a55ec97b6a9423a3c568b9f8ff6b83abec8b536424a8bc43fb7eba2fd5a8",
  boxplot: "b3fe06c5019fa3f12ce77d941d4ad2daef6564176a2d97c794bd291c83505dd2",
  scatter: "bc5c2f49084d793e25d26923046d7392c5d33be5cdca1efed18a02798c749ad5",
  heatmap: "ce17a2ac831ad2b100ab21cd485678b2a8c9ce98ecc083eb53a8ed20ca9a61d8",
  area: "d7f991696052cae584c92cbab99031f9f52f3c57d248f420c2a1391e9d456765",
  areaPercent: "36e10938e999ff0164e77d66536b2ac32dcc011d80e27e2038a3855813b2395b",
};
const savedDigests = new Map(Object.entries(savedSvg));
for (const fixture of savedChartFixtures) {
  test(`saved ${fixture.kind} SQL renders byte-identically to main`, () => {
    const panel = DashboardPanelSchema.parse({
      id: "saved",
      title: "Saved observations",
      kind: fixture.kind,
      columns: fixture.columns,
      x: fixture.x,
      series: fixture.series,
      sql: "SELECT 1",
    });
    const data = {
      columns: fixture.columns.map((name) => ({ name, type: name === "time" ? "DateTime('UTC')" : "Float64" })),
      rows: fixture.rows,
    };
    const svg = drawChart(dashboardChartRenderOptions(panel, data, { locale: "en", timeZone: "UTC" }));
    const expected = savedDigests.get(fixture.kind);
    if (!expected) throw new Error(`Missing saved SVG for ${fixture.kind}`);
    expect(new Bun.CryptoHasher("sha256").update(svg).digest("hex")).toBe(expected);
  });
}
