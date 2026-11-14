import { expect, test } from "bun:test";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { dotMatrixFixtures } from "../../test/chart-dot-matrix-fixtures";

const { plugin } = createConfig({ dev: true, rootDir: import.meta.dir });
Bun.plugin(plugin());
const { default: Chart, chartRenderHeight, renderChartSvg } = await import("./Chart");
test("dot matrix SSR embeds the same pure drawing as the first client render", () => {
  for (const spec of dotMatrixFixtures) {
    const html = renderToString(() => createComponent(Chart, { ...spec, style: { height: "240px" } }));
    const { kind, ...props } = spec;
    expect(renderToString(() => createComponent(Chart.Bar, { ...props, style: { height: "240px" } }))).toBe(html);
    expect(html).toContain(renderChartSvg(spec, 480, chartRenderHeight(spec)));
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip"');
  }
});
