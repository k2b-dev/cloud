// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.
import {
  type BoxPlotOptions,
  chartDatumSvg,
  computeAxisScale,
  computeBoxStats,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  emptyChart,
  fmt,
  normalizePadding,
  pickMapper,
  renderHeader,
  renderReferenceLines,
  renderXAxisCategorical,
  renderYAxis,
  svgRoot,
} from "./svg-common";
/**
 * Render a box plot (Tukey style): box for the IQR (Q1-Q3), median line,
 * whiskers extending to 1.5×IQR fences, and individual outlier dots.
 *
 * Useful for comparing distributions across categorical groups (e.g. test
 * scores per class, reaction times per condition).
 *
 * @example
 * charts.boxplot({
 *   groups: [
 *     { label: "Class A", values: scoresA },
 *     { label: "Class B", values: scoresB },
 *   ],
 *   yAxis: { label: "Score" },
 * });
 */
export const boxplot = (opts: BoxPlotOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);

  const showOutliers = opts.showOutliers ?? true;

  const stats = opts.groups.map((g, index) => ({
    index,
    count: g.values.filter(Number.isFinite).length,
    label: g.label,
    s: computeBoxStats(g.values),
  }));
  const valid = stats.filter((g) => g.s !== null) as Array<{
    label: string;
    index: number;
    count: number;
    s: NonNullable<ReturnType<typeof computeBoxStats>>;
  }>;
  if (valid.length === 0) return emptyChart(width, height, opts.className);

  const area = computePlotArea(width, height, padding, false, !!opts.yAxis?.label, header.height, 0);

  // Collect all values relevant for the y-domain: whisker extremes + outliers.
  const axisValues: number[] = [];
  for (const g of valid) {
    axisValues.push(g.s.whiskerLow, g.s.whiskerHigh);
    if (showOutliers) axisValues.push(...g.s.outliers);
  }
  const yAxis = computeAxisScale(axisValues, opts.yAxis);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(
    renderXAxisCategorical(
      valid.map((g) => g.label),
      area,
      height,
      undefined,
    ),
  );

  const slot = (area.x1 - area.x0) / valid.length;
  const boxWidth = slot * 0.6;
  const boxOffset = slot * 0.2;

  for (let i = 0; i < valid.length; i++) {
    const g = valid[i]!;
    const cx = area.x0 + slot * i + slot / 2;
    const x = area.x0 + slot * i + boxOffset;
    const seriesIdx = opts.colorByBox ? i % 8 : 0;
    const seriesCls = `stdlib-chart-series-${seriesIdx}`;
    const yQ1 = yMap(g.s.q1, yAxis.domain, [area.y1, area.y0]);
    const yQ2 = yMap(g.s.q2, yAxis.domain, [area.y1, area.y0]);
    const yQ3 = yMap(g.s.q3, yAxis.domain, [area.y1, area.y0]);
    const yWhiskerLow = yMap(g.s.whiskerLow, yAxis.domain, [area.y1, area.y0]);
    const yWhiskerHigh = yMap(g.s.whiskerHigh, yAxis.domain, [area.y1, area.y0]);

    // Whisker line (vertical) from low whisker to high whisker, behind the box.
    body.push(
      `<line class="stdlib-chart-box-whisker" x1="${fmt(cx)}" y1="${fmt(yWhiskerHigh)}" x2="${fmt(cx)}" y2="${fmt(yWhiskerLow)}"/>`,
    );
    // Whisker caps.
    const capW = boxWidth * 0.4;
    body.push(
      `<line class="stdlib-chart-box-cap" x1="${fmt(cx - capW / 2)}" y1="${fmt(yWhiskerHigh)}" x2="${fmt(cx + capW / 2)}" y2="${fmt(yWhiskerHigh)}"/>`,
    );
    body.push(
      `<line class="stdlib-chart-box-cap" x1="${fmt(cx - capW / 2)}" y1="${fmt(yWhiskerLow)}" x2="${fmt(cx + capW / 2)}" y2="${fmt(yWhiskerLow)}"/>`,
    );
    // Box (Q1 to Q3).
    body.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-box ${seriesCls}" x="${fmt(x)}" y="${fmt(yQ3)}" width="${fmt(boxWidth)}" height="${fmt(yQ1 - yQ3)}"/>`,
        {
          index: g.index,
          role: "box",
          label: g.label,
          anchor: [cx, yQ2],
          values: [
            { key: "count", value: g.count },
            ...(["q1", "q2", "q3", "whiskerLow", "whiskerHigh"] as const)
              .map((key) => ({ key, value: g.s[key] }))
              .map((field) => ({ ...field, formatted: opts.yAxis?.format?.(field.value) })),
          ],
        },
        opts.inspect,
      ),
    );
    // Median line.
    body.push(`<line class="stdlib-chart-box-median" x1="${fmt(x)}" y1="${fmt(yQ2)}" x2="${fmt(x + boxWidth)}" y2="${fmt(yQ2)}"/>`);
    // Outliers.
    if (showOutliers) {
      const sourceIndices = new Map<number, number[]>();
      if (opts.inspect)
        opts.groups[g.index]!.values.forEach((value, index) => {
          const indices = sourceIndices.get(value) ?? [];
          indices.push(index);
          sourceIndices.set(value, indices);
        });
      for (const v of g.s.outliers) {
        const sourceIndex = sourceIndices.get(v)?.shift() ?? 0;
        const oy = yMap(v, yAxis.domain, [area.y1, area.y0]);
        body.push(
          chartDatumSvg(
            `<circle class="stdlib-chart-box-outlier ${seriesCls}" cx="${fmt(cx)}" cy="${fmt(oy)}" r="2.5"/>`,
            {
              index: sourceIndex,
              seriesIndex: g.index,
              role: "outlier",
              label: g.label,
              anchor: [cx, oy],
              values: [{ key: "value", value: v, formatted: opts.yAxis?.format?.(v) }],
            },
            opts.inspect,
          ),
        );
      }
    }
  }

  if (opts.references && opts.references.length > 0) {
    const yRefs = opts.references.filter((r) => (r.axis ?? "y") === "y");
    if (yRefs.length > 0) {
      body.push(renderReferenceLines(yRefs, { domain: [0, 1], scale: "linear" }, yAxis, area));
    }
  }

  return svgRoot({ width, height, className: opts.className }, header.svg + body.join(""));
};
