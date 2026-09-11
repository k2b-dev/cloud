/** Adapt our generated SVGs to a CSS-sized box without rebuilding their geometry.
 * Only stdlib and the local timeline renderer supply this markup; this is not a
 * parser for arbitrary SVG. The viewBox remains the interaction coordinate space.
 */
export function responsiveChartSvg(svg: string): string {
  return svg.replace("<svg ", '<svg preserveAspectRatio="none" ').replace(/<text\b[^>]*>/g, (tag) => {
    const x = tag.match(/\bx="(-?[\d.]+)"/)?.[1];
    const y = tag.match(/\by="(-?[\d.]+)"/)?.[1];
    if (x === undefined || y === undefined) return tag;
    const rotation = tag.match(/\btransform="rotate\((-?[\d.]+) [^\"]+\)"/)?.[1];
    // Individual CSS scale precedes rotation. Use the same text anchor as
    // transform-origin, and avoid applying the SVG rotation pivot twice.
    return tag.replace(">", ` style="transform-origin:${x}px ${y}px${rotation ? `;transform:rotate(${rotation}deg)` : ""}">`);
  });
}

/** Add initial controlled selection to our own renderer metadata during SSR. */
export function selectedChartSvg(svg: string, selected: { role: string; index: number; seriesIndex?: number } | null | undefined): string {
  if (!selected) return svg;
  return svg.replace(/data-chart-datum="([^"]*)"/g, (attribute, encoded: string, offset: number) => {
    const raw = encoded.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("role" in value) || !("index" in value)) return attribute;
    const matches = value.role === selected.role && value.index === selected.index && ("seriesIndex" in value ? value.seriesIndex : undefined) === selected.seriesIndex;
    if (!matches) return attribute;
    const children = svg.slice(offset, svg.indexOf("</g>", offset));
    const palette = Number(children.match(/stdlib-chart-series-(\d+)/)?.[1] ?? selected.seriesIndex ?? 0) % 8 + 1;
    return `data-selected style="--k2b-chart-selection-color:color-mix(in srgb,var(--stdlib-chart-c${palette}) 72%,var(--k2b-chart-highlight-mix))" ${attribute}`;
  });
}
