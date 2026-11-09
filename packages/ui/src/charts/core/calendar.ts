import {
  type CalendarHeatmapOptions,
  calendarColor,
  calendarLayout,
  calendarWords,
  DAY,
  type HeatmapChartOptions,
  pixels,
} from "./calendar-layout";
import { chartDatumSvg, escapeXml, heatmap, renderHeader, svgRoot } from "./svg-renderers";
import { chartTextWidth } from "./text";

export {
  CALENDAR_MAX_DAYS,
  type CalendarHeatmapOptions,
  calendarDay,
  calendarLayout,
  calendarViewportHeight,
  calendarWeekStart,
  calendarWords,
  type HeatmapChartOptions,
} from "./calendar-layout";

const paint = (color: string, intensity: number) =>
  `color-mix(in srgb,${color} ${12 + 88 * Math.sqrt(intensity)}%,var(--k2b-surface-muted,#f4f4f5))`;
export function renderCalendarSvg(spec: CalendarHeatmapOptions): string {
  const s = calendarLayout(spec),
    locale = spec.locale ?? "en",
    words = calendarWords(locale);
  const { cell, top, width } = s;
  const step = cell + 3;
  const number = spec.format ?? new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format;
  // Explicit fields avoid the engine-dependent dateStyle pattern.
  const dateFormat = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  const parts = dateFormat({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const weekday = dateFormat({ weekday: "short" });
  const month = dateFormat({ month: "short" });
  // Left aligned direct-core header; interactive hosts keep it at the visible scroll edge.
  const header = renderHeader(width, spec.title, spec.subtitle)
    .svg.replace(/x="[^"]*"/g, 'x="0"')
    .replace(/text-anchor="middle"/g, 'text-anchor="start"')
    .replace(/<text /g, '<text fill="var(--k2b-text,#27272a)" font-size="12" ');
  const fixed = 'data-calendar-fixed=""';
  const pinned = 'data-calendar-pinned=""';
  const fixedAt = (x: number, y: number) => `<g transform="translate(${x} ${y})"><g ${fixed}>`;
  const textStyle = 'fill="var(--k2b-text-muted,#45454e)" font-size="11"';
  const body: string[] = [`<g ${pinned}><g ${fixed}>${header}</g></g>`];
  const days: string[] = [
    `<g ${pinned}><g data-calendar-weekdays="true" pointer-events="none"><rect x="${-cell - 4}" y="${top - 18}" width="${cell + 36}" height="${7 * step + 18}" fill="var(--k2b-surface,#fff)"/>`,
  ];
  for (const day of [0, 2, 4])
    days.push(
      `${fixedAt(32, top + day * step + cell / 2)}<text x="-3" y="0" text-anchor="end" dominant-baseline="middle" ${textStyle}>${escapeXml(weekday.format(Date.UTC(2026, 0, 4 + s.weekStart + day)))}</text></g></g>`,
    );
  let lastRight = -Infinity,
    lastMonth = "";
  for (let week = 0; week < s.weeks; week++) {
    const time = s.firstMonday + week * 7 * DAY,
      next = Math.min(time + 6 * DAY, s.lastDay);
    const nextDate = new Date(next),
      ym = nextDate.toISOString().slice(0, 7);
    if (ym === lastMonth) continue;
    lastMonth = ym;
    const text = month.format(next);
    const textWidth = chartTextWidth(text, 11);
    const x = Math.min(width - textWidth - 2, Math.max(32 + week * step, lastRight + 3));
    // Scale the label block around its grid anchor, keeping the two text rows together.
    body.push(fixedAt(x, top));
    if (week === 0 || nextDate.getUTCMonth() === 0)
      body.push(`<text x="0" y="-22" font-size="10" fill="var(--k2b-text-muted,#45454e)">${nextDate.getUTCFullYear()}</text>`);
    body.push(`<text data-calendar-month="${week}" x="0" y="-8" ${textStyle}>${escapeXml(text)}</text></g></g>`);
    lastRight = x + textWidth;
  }
  for (const c of s.cells) {
    const d = Object.fromEntries(parts.formatToParts(c.time).map((part) => [part.type, part.value]));
    const date = locale.startsWith("de")
      ? `${d.day}. ${d.month} ${d.year}`
      : /^en(?:-US)?$/.test(locale)
        ? `${d.month} ${d.day}, ${d.year}`
        : `${d.day} ${d.month} ${d.year}`;
    const fill = spec.scale === "diverging" && c.value === 0 ? "var(--k2b-surface-muted,#f4f4f5)" : paint(c.color, c.intensity);
    const value =
      spec.scale === "diverging" && c.value !== 0
        ? `${number(Math.abs(c.value))} ${c.value < 0 ? words.moreOut : words.moreIn}`
        : number(c.value);
    body.push(
      chartDatumSvg(
        `<rect x="${c.x}" y="${c.y}" width="${cell}" height="${cell}" rx="2" fill="${fill}" stroke="none"/>`,
        {
          role: "cell",
          index: c.index,
          label: `${d.weekday}, ${date}`,
          anchor: [c.x + cell / 2, c.y + cell / 2],
          grid: [c.week, c.weekday],
          values: [{ key: "value", value: c.value, formatted: value }],
        },
        spec.inspect,
      ),
    );
  }
  days.push("</g></g>");
  body.push(days.join(""));
  const legendY = top + 7 * step + 12;
  const start = spec.scale === "diverging" ? words.moreOut : words.less,
    end = spec.scale === "diverging" ? words.moreIn : words.more;
  const swatches = spec.scale === "diverging" ? [-1, -0.5, 0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const offset = chartTextWidth(start, 11) + 4;
  body.push(
    `<g ${pinned} data-calendar-legend="true">${fixedAt(32, legendY - 6)}<text x="0" y="10" ${textStyle}>${escapeXml(start)}</text>`,
  );
  swatches.forEach((v, i) => {
    const color = calendarColor(spec.scale, v);
    body.push(
      `<rect x="${offset + i * 14}" y="0" width="11" height="11" rx="2" fill="${spec.scale === "diverging" && v === 0 ? "var(--k2b-surface-muted,#f4f4f5)" : paint(color, Math.abs(v))}"/>`,
    );
  });
  body.push(`<text x="${offset + swatches.length * 14 + 4}" y="10" ${textStyle}>${escapeXml(end)}</text></g></g></g>`);
  return svgRoot({ ...s, className: spec.className }, body.join("")).replace(
    "<svg ",
    `<svg data-calendar="true" data-chart-min-width="${s.minWidth}" style="--k2b-calendar-min:${pixels(s.minWidth)};--k2b-calendar-max:${pixels(s.maxWidth)};--k2b-calendar-base:${width}px;--k2b-calendar-step:${step / width}" `,
  );
}
export const renderHeatmapSvg = (spec: HeatmapChartOptions): string =>
  spec.layout === "calendar" ? renderCalendarSvg(spec) : heatmap(spec);
