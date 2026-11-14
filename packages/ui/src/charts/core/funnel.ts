import { type FunnelLayout, type FunnelOptions, funnelLayout } from "./funnel-layout";
import { chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg-renderers";

export { type FunnelLayout, type FunnelOptions, funnelLayout } from "./funnel-layout";

export function renderFunnelSvg(spec: FunnelOptions & { width: number; height: number; inspect?: boolean }) {
  return renderFunnelLayoutSvg(spec, funnelLayout(spec, spec));
}

/** Draw the same geometry reserved before a lazy host loads its renderer. */
export function renderFunnelLayoutSvg(spec: FunnelOptions & { width: number; height: number; inspect?: boolean }, g: FunnelLayout) {
  const text = (x: number, y: number, value: string, anchor = "start", cls = "stdlib-chart-tick-label") =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
  const parts: string[] = [renderHeader(spec.width, spec.title, spec.subtitle).svg];
  for (const step of g.steps) {
    const next = g.steps[step.index + 1];
    if (next && step.value !== null && next.value !== null)
      parts.push(
        `<polygon points="${g.center - step.width / 2},${step.y + g.barHeight} ${g.center + step.width / 2},${step.y + g.barHeight} ${g.center + next.width / 2},${next.y} ${g.center - next.width / 2},${next.y}" style="fill:var(--stdlib-chart-c1,#3b82f6);fill-opacity:.09"/>`,
      );
    const marks = `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="0" y="${g.top + step.index * g.pitch}" width="${g.width}" height="${g.pitch}" rx="6"/>${step.value === null ? "" : `<rect class="stdlib-chart-bar" x="${g.center - step.width / 2}" y="${step.y}" width="${step.width}" height="${g.barHeight}" rx="3" style="fill:var(--stdlib-chart-c1,#3b82f6);fill-opacity:${Math.max(0.3, 1 - step.index * 0.14)}" stroke="none" stroke-width="0"/>`}`;
    parts.push(chartDatumSvg(marks, step.datum, spec.inspect ?? false, step.title));
    const lines = step.labelLines;
    lines.forEach((line, i) => parts.push(text(0, step.y + g.barHeight / 2 + 4 + (lines.length > 1 ? (i === 0 ? -6.5 : 6.5) : 0), line)));
    parts.push(text(g.width, step.y + g.barHeight / 2 + (step.index ? -2 : 4), step.valueText, "end", "stdlib-chart-bar-value"));
    if (step.index) parts.push(text(g.width, step.y + g.barHeight / 2 + 12, step.shareText, "end"));
  }
  return svgRoot({ ...spec, className: [spec.className, "k2b-chart-funnel"].filter(Boolean).join(" ") }, parts.join(""))
    .replace("</style>", ".k2b-chart-funnel :is(.stdlib-chart-tick-label,.stdlib-chart-bar-value){font-size:12.5px}</style>")
    .replace("<svg ", '<svg data-bar-layout="rows" ');
}
