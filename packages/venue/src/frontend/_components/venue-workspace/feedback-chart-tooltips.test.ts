import { expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import type { ChartSelection } from "@k2b/ui";
import { venueMessages } from "../../../messages";
import { formatDateKey } from "../../../time-format";
import { feedbackCountTooltip, feedbackRatingTooltip } from "./feedback-chart-tooltips";

const de = venueMessages.resolve(["de"]).t;
const days = ["2026-09-26", "2026-09-27"];
const dayLabels = days.map((day) => formatDateKey(day, "de"));
const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** The first datum the renderer marks for inspection, as the @k2b/ui Chart hands it to the tooltip. */
const firstSelection = (kind: ChartSelection["kind"], svg: string): ChartSelection => {
  const raw = svg.match(/data-chart-datum="([^"]*)"/)?.[1];
  if (!raw) throw new Error(`No inspectable datum in the ${kind} chart`);
  return { kind, datum: JSON.parse(unescape(raw)) };
};
// The island's axes: one slot per day, labelled with the day; the 1–5 scale for the rating.
const xAxis = { domain: [0.5, days.length + 0.5] as [number, number], format: (value: number) => dayLabels[Math.round(value) - 1] ?? "" };
const yAxis = { domain: [1, 5] as [number, number], ticks: 5, format: (value: number) => `${value}/5` };
const rating = feedbackRatingTooltip({ dayLabels, label: de.averageRating, locale: "de" });
const noGenericText = (tooltip: ReturnType<typeof rating>) =>
  expect(JSON.stringify(tooltip)).not.toMatch(/Value|Wert|"X"|"Y"|"x"|"y"|"Datenreihe/);

test("the average-rating line names the day and the rating on the 1–5 scale", () => {
  const svg = charts.line({
    series: [
      {
        label: de.averageRating,
        data: [
          { x: 1, y: 4.25 },
          { x: 2, y: 3 },
        ],
      },
    ],
    xAxis,
    yAxis,
    smooth: false,
    inspect: true,
  });
  const tooltip = rating(firstSelection("line", svg));
  expect(tooltip).toEqual({ title: formatDateKey("2026-09-26", "de"), rows: [{ label: "Durchschnittliche Bewertung", value: "4,3/5" }] });
  noGenericText(tooltip);
});

test("a single day's point names its day and rating like the line", () => {
  const svg = charts.scatter({
    series: [{ label: de.averageRating, data: [{ x: 1, y: 5 }] }],
    xAxis: { ...xAxis, domain: [0.5, 1.5] },
    yAxis,
    inspect: true,
  });
  const tooltip = rating(firstSelection("scatter", svg));
  expect(tooltip).toEqual({ title: dayLabels[0], rows: [{ label: "Durchschnittliche Bewertung", value: "5,0/5" }] });
  noGenericText(tooltip);
});

test("ratings per day name the day and count the ratings as a whole number", () => {
  const svg = charts.bar({
    data: [
      { label: dayLabels[0]!, value: 1234 },
      { label: dayLabels[1]!, value: 2 },
    ],
    inspect: true,
  });
  const tooltip = feedbackCountTooltip({ label: de.ratings, locale: "de" })(firstSelection("bar", svg));
  expect(tooltip).toEqual({ title: dayLabels[0], rows: [{ label: "Bewertungen", value: "1.234" }] });
  noGenericText(tooltip);
});
