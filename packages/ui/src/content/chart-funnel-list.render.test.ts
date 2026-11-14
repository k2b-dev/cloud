import { expect, test } from "bun:test";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { funnelListFixtures } from "../../test/chart-funnel-list-fixtures";
import { parseRows069, positiveRows069Json } from "../../test/chart-rows-069-fixture";

const { plugin } = createConfig({ dev: true, rootDir: import.meta.dir });
Bun.plugin(plugin());
const { default: Chart, chartRenderHeight, renderChartSvg } = await import("./Chart");
test("funnel and ranked-list SSR embeds the same pure drawing as the first client render", () => {
  for (const spec of funnelListFixtures) {
    const html = renderToString(() => createComponent(Chart, { ...spec, style: { height: "240px" } }));
    expect(html).toContain(renderChartSvg(spec, 480, chartRenderHeight(spec)));
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip"');
  }
});

test("frozen positive 0.69 rows retain their core drawing inside Solid SSR", () => {
  for (const json of Object.values(positiveRows069Json)) {
    const spec = parseRows069(json);
    const html = renderToString(() => createComponent(Chart, spec));
    expect(html).toContain(renderChartSvg(spec, 480, chartRenderHeight(spec)));
    expect(html).not.toContain("k2b-chart-ranked");
  }
});
