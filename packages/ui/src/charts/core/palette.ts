// Matches base.css. Keep legacy renderer bytes intact; standalone exporters opt in.
const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316"];

/** Use the UI's eight colors in a generated chart SVG, including hosts without chart CSS.
 * Changes only embedded palette defaults and numeric color-variable fallbacks.
 * Geometry, semantic tones, inspection metadata and explicitly chosen colors stay intact.
 */
export function chartSvgWithUiPalette(svg: string): string {
  return svg
    .replace(
      /<style>([\s\S]*?)<\/style>/g,
      (_tag, css: string) =>
        `<style>${css.replace(/(--stdlib-chart-c([1-8]):\s*)#[0-9a-f]{6}\b/gi, (_match, declaration: string, index: string) => `${declaration}${palette[Number(index) - 1]}`)}</style>`,
    )
    .replace(
      /var\(--stdlib-chart-c([1-8]),\s*#[0-9a-f]{3,8}\)/gi,
      (_match, index: string) => `var(--stdlib-chart-c${index},${palette[Number(index) - 1]})`,
    );
}
