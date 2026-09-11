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
