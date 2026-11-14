import { type HorizontalBarLayout, type HorizontalBarOptions, hbarLayout } from "./hbar-layout";
import { chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg-renderers";

export { type HorizontalBarLayout, type HorizontalBarOptions, hbarLayout } from "./hbar-layout";

export function renderHbarSvg(spec: HorizontalBarOptions & { width: number; height: number; inspect?: boolean }) {
  return renderHbarLayoutSvg(spec, hbarLayout(spec, spec));
}

/** Draw an already prepared layout; lazy hosts reuse the geometry reserved before loading. */
export function renderHbarLayoutSvg(
  spec: HorizontalBarOptions & { width: number; height: number; inspect?: boolean },
  g: HorizontalBarLayout,
) {
  const text = (x: number, y: number, value: string, anchor = "start", extra = "", attrs = 'class="stdlib-chart-tick-label"') =>
    `<text ${attrs} x="${x}" y="${y}" text-anchor="${anchor}" ${extra}>${escapeXml(value)}</text>`;
  const parts: string[] = [renderHeader(spec.width, spec.title, spec.subtitle).svg];
  const header = g.header;
  if (spec.legend !== false)
    g.legend.items.forEach((entry, i) => {
      const y = header + entry.y;
      parts.push(
        `<rect class="stdlib-chart-series-${i % 8}" x="${entry.x}" y="${y - 8}" width="${8 * g.unit}" height="8"/>`,
        text(entry.x + 14 * g.unit, y, entry.text),
        text(
          entry.valueX,
          y,
          entry.valueText,
          "end",
          `data-chart-legend-value data-field="series:${i}" data-default="${escapeXml(entry.valueText)}"`,
        ),
      );
    });
  if (spec.legend !== false && g.legend.hidden) parts.push(text(0, header + g.legend.height - 8, `+${g.legend.hidden}`));
  for (const tick of g.scale.ticks)
    parts.push(
      `<line class="stdlib-chart-grid" x1="${g.x(tick)}" x2="${g.x(tick)}" y1="${g.top}" y2="${g.height - 24}"/>`,
      text(g.x(tick), g.height - 5, g.format(tick), "middle"),
    );
  for (const row of g.rows) {
    if (row.groupHeading !== undefined) {
      parts.push(
        text(
          0,
          row.groupY + 14,
          row.groupHeading,
          "start",
          "",
          'class="k2b-chart-group-heading" font-size="11.5" font-weight="600" fill="currentColor"',
        ),
      );
    }
    const height = Math.min(26, g.pitch * 0.74);
    const marks = [
      `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="0" y="${row.center - g.pitch / 2}" width="${spec.width}" height="${g.pitch}" rx="6"/>`,
    ];
    for (const segment of row.segments) {
      if (segment.value === null) continue;
      marks.push(
        `<rect class="stdlib-chart-bar stdlib-chart-series-${segment.seriesIndex % 8}" x="${segment.x}" y="${row.center - height / 2}" width="${Math.max(segment.width / 2, segment.width - 1.5)}" height="${height}" rx="3" stroke="none" stroke-width="0" style="fill:var(--stdlib-chart-c${(segment.seriesIndex % 8) + 1},#3b82f6);fill-opacity:.18"/>`,
      );
      if (segment.showLabel)
        marks.push(
          text(
            segment.x + segment.width / 2,
            row.center + 4,
            segment.label,
            "middle",
            "",
            'class="k2b-chart-segment-value" font-size="11" font-weight="500" fill="currentColor"',
          ),
        );
    }
    parts.push(chartDatumSvg(marks.join(""), row.datum, spec.inspect ?? false, row.title));
    row.labelLines.forEach((line, i) =>
      parts.push(text(g.left - 8 * g.unit, row.center + 4 + (row.labelLines.length > 1 ? (i === 0 ? -6.5 : 6.5) : 0), line, "end")),
    );
    parts.push(text(g.x(row.total ?? 0) + 6 * g.unit, row.center + 4, row.valueText));
  }
  return svgRoot({ ...spec, height: g.height }, parts.join("")).replace("<svg ", '<svg data-bar-layout="rows" ');
}
