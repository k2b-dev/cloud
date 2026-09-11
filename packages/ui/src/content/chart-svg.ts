import type { MapViewport } from "@k2b/stdlib";

/** Give maps a CSS-sized viewport while retaining the renderer's projection.
 * The outer SVG uses pixels for headers/legend; the nested geographic viewport
 * keeps one fitted scale across zoom levels and clips only at the plot edges.
 */
export function responsiveMapSvg(svg: string, width: number, height: number, viewport: MapViewport): string {
  if (!svg.includes('class="stdlib-chart-map-viewport"')) return svg;
  const zoomScale = 2 ** viewport.zoom;
  return svg
    .replace(/<text class="stdlib-chart-(title|subtitle|map-empty)"[^>]*>/g, (tag) => {
      const centered = tag.replace(/x="[^"]*"/, 'x="50%"');
      return tag.includes("map-empty") ? centered.replace(/y="[^"]*"/, 'y="50%"') : centered;
    })
    .replace(/^(<svg\b[^>]*?) viewBox="[^"]*"/, "$1")
    .replace(/<svg class="stdlib-chart-map-viewport"[^>]*>/, (tag) => {
      const mapWidth = Number(tag.match(/\bwidth="([^"]+)"/)?.[1]);
      const mapHeight = Number(tag.match(/\bheight="([^"]+)"/)?.[1]);
      const inverse = `calc(max(tan(atan2(${mapWidth}px, ${(mapWidth / width) * 100}cqw)), tan(atan2(${mapHeight}px, ${(mapHeight / height) * 100}cqh))) / ${zoomScale})`;
      const translateX = mapWidth / 2 - ((viewport.longitude + 180) / 360) * mapWidth * zoomScale;
      const translateY = mapHeight / 2 - ((90 - viewport.latitude) / 180) * mapHeight * zoomScale;
      return tag
        .replace(
          /\b(x|y|width|height)="([\d.]+)"/g,
          (_match, name: string, value: string) =>
            `${name}="${(Number(value) / (name === "x" || name === "width" ? width : height)) * 100}%"`,
        )
        .replace(
          ">",
          ` preserveAspectRatio="xMidYMid meet" style="--k2b-map-inverse-scale:${inverse}"><g class="k2b-chart-map-camera" transform="translate(${translateX} ${translateY}) scale(${zoomScale})">`,
        );
    })
    .replace("</svg>", "</g></svg>");
}

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
export function selectedChartSvg(
  svg: string,
  selected:
    | { role: string; index: number; seriesIndex?: number }
    | readonly { role: string; index: number; seriesIndex?: number }[]
    | null
    | undefined,
): string {
  if (!selected) return svg;
  const targets = "role" in selected ? [selected] : selected;
  return svg.replace(/<g\b[^>]*\bdata-chart-datum="([^"]*)"[^>]*>/g, (attribute, encoded: string, offset: number) => {
    const raw = encoded
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("role" in value) || !("index" in value)) return attribute;
    const matches = targets.find(
      (target) =>
        value.role === target.role &&
        value.index === target.index &&
        ("seriesIndex" in value ? value.seriesIndex : undefined) === target.seriesIndex,
    );
    if (!matches) return attribute;
    const children = svg.slice(offset, svg.indexOf("</g>", offset));
    const palette = (Number(children.match(/stdlib-chart-series-(\d+)/)?.[1] ?? matches.seriesIndex ?? 0) % 8) + 1;
    const paint = `--k2b-chart-selection-color:color-mix(in srgb,var(--stdlib-chart-c${palette}) 72%,var(--k2b-chart-highlight-mix))`;
    const opening = attribute.includes('style="')
      ? attribute.replace(/style="([^"]*)"/, (_match: string, style: string) => `style="${style};${paint}"`)
      : attribute.replace(">", ` style="${paint}">`);
    return opening.replace(">", " data-selected>");
  });
}
