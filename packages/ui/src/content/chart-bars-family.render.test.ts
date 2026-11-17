import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { barFamilyFixtures } from "../../test/chart-bars-family-fixtures";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

registerSsrTestPlugin({ dev: true, rootDir: import.meta.dir });

const { default: Chart, chartRenderHeight, renderChartSvg } = await import("./Chart");
test("bars SSR embeds the same pure drawing as the first client render", () => {
  for (const spec of barFamilyFixtures) {
    const html = renderToString(() => createComponent(Chart, { ...spec, style: { height: "240px" } }));
    expect(html).toContain(renderChartSvg(spec, 480, chartRenderHeight(spec)));
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip"');
  }
});
