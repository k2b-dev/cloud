/**
 * Flat parity probe (Cloud flach, K2/K7/K11): runs in the page. For each area (a list or a reader column) it reports
 * every horizontal hairline and row fill that does not reach both area edges (±0.5 px), every pair of hairlines that
 * stand 1–8 px apart (a doubled line), and the font sizes of all visible text. Plain script, no imports.
 */
export type FlatProbe = {
  areas: {
    name: string;
    left: number;
    right: number;
    short: { what: string; left: number; right: number }[];
    double: { a: string; b: string; gap: number }[];
    sizes: Record<string, string[]>;
  }[];
};

export const probeFlat = (areas: [name: string, selector: string][]): FlatProbe => {
  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${Array.from(element.classList)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("")}`;
  // A visually hidden box (1 px, clipped, such as `.sr-only`) holds text for screen readers only.
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const result: FlatProbe = { areas: [] };
  for (const [name, selector] of areas) {
    const area = document.querySelector(selector);
    if (!area || !visible(area)) continue;
    const box = area.getBoundingClientRect();
    const areaStyle = getComputedStyle(area);
    // The area's own edges: inside its own borders.
    const left = box.left + Number.parseFloat(areaStyle.borderLeftWidth);
    const right = box.right - Number.parseFloat(areaStyle.borderRightWidth);
    const lines: { what: string; y: number; left: number; right: number }[] = [];
    const short: FlatProbe["areas"][number]["short"] = [];
    const sizes: Record<string, string[]> = {};
    for (const element of [area, ...Array.from(area.querySelectorAll("*"))]) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) continue;
      // A structure line or fill spans most of its area; smaller ones belong to controls (chips, buttons, fields).
      const wide = rect.width >= (right - left) * 0.6;
      const radius = Number.parseFloat(style.borderTopLeftRadius) + Number.parseFloat(style.borderBottomRightRadius);
      if (element !== area && wide && radius === 0) {
        for (const side of ["Top", "Bottom"] as const) {
          const width = Number.parseFloat(style[`border${side}Width`]);
          if (width > 0 && style[`border${side}Style`] !== "none" && style[`border${side}Color`] !== "rgba(0, 0, 0, 0)") {
            const y = side === "Top" ? rect.top : rect.bottom - width;
            lines.push({ what: `${label(element)} ${side.toLowerCase()}`, y, left: rect.left, right: rect.right });
            if (Math.abs(rect.left - left) > 0.5 || Math.abs(rect.right - right) > 0.5)
              short.push({ what: `${label(element)} line`, left: rect.left - left, right: right - rect.right });
          }
        }
        const fill = style.backgroundColor;
        if (fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent" && rect.height <= 120 && element.closest("[aria-selected='true'], [aria-current], .mail-list-entry-active"))
          if (Math.abs(rect.left - left) > 0.5 || Math.abs(rect.right - right) > 0.5)
            short.push({ what: `${label(element)} fill`, left: rect.left - left, right: right - rect.right });
      }
      const own = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (own && rect.top < box.bottom && rect.bottom > box.top) {
        const key = `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`;
        (sizes[key] ??= []).length < 3 && sizes[key]!.push(`${label(element)} "${element.textContent!.trim().slice(0, 24)}"`);
      }
    }
    lines.sort((a, b) => a.y - b.y);
    const double: FlatProbe["areas"][number]["double"] = [];
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length && lines[j]!.y - lines[i]!.y <= 8; j++) {
        const gap = lines[j]!.y - lines[i]!.y;
        const overlap = Math.min(lines[i]!.right, lines[j]!.right) - Math.max(lines[i]!.left, lines[j]!.left);
        if (gap >= 1 && overlap > 40) double.push({ a: lines[i]!.what, b: lines[j]!.what, gap: Math.round(gap * 10) / 10 });
      }
    result.areas.push({ name, left, right, short, double, sizes });
  }
  return result;
};
