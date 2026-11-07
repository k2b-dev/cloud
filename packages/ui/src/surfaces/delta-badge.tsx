import type { JSX } from "solid-js";
import { useLocale } from "../intl/locale";
import type { StatCellCompare, StatCellDelta } from "./StatCell";
import { type StatCellMessages, useStatCellMessages } from "./stat-cell-messages";

// The change badge of a key figure, on its own so a table cell can show it without the tile and its trend chart.

/** The change as shown: one decimal of a percent or point, so text, arrow and rating never disagree. */
const shownDelta = (delta: StatCellDelta): number => Math.round(delta.value * 1000) / 1000 || 0;

const deltaTone = (delta: StatCellDelta): "good" | "bad" | "neutral" => {
  const value = shownDelta(delta);
  return !delta.better || value === 0 ? "neutral" : value > 0 === (delta.better === "up") ? "good" : "bad";
};

/** Signed with a true minus sign (U+2212), as figures are typeset. */
export const deltaText = (delta: StatCellDelta, locale: string, t: StatCellMessages): string =>
  (delta.unit === "points"
    ? `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(shownDelta(delta) * 100)} ${t.points}`
    : new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
        signDisplay: "exceptZero",
      }).format(shownDelta(delta))
  ).replace("-", "\u2212");

/** A change badge: arrow, signed text, and a spoken label that names the comparison and, with `better`, the rating. */
export function DeltaBadge(props: { delta: StatCellDelta; compare?: StatCellCompare }): JSX.Element {
  const locale = useLocale();
  const t = useStatCellMessages();
  const tone = () => deltaTone(props.delta);
  const text = () => deltaText(props.delta, locale(), t());
  const label = () =>
    [text(), props.compare ? t().comparedWith({ label: props.compare.label }) : ""].filter(Boolean).join(" ") +
    (tone() === "good" ? `, ${t().better}` : tone() === "bad" ? `, ${t().worse}` : "");
  const icon = () => (shownDelta(props.delta) > 0 ? "ti-trending-up" : shownDelta(props.delta) < 0 ? "ti-trending-down" : "ti-minus");
  return (
    <span class="k2b-stat-cell__delta" data-tone={tone()} role="img" aria-label={label()}>
      <i class={`ti ${icon()}`} aria-hidden="true" />
      {text()}
    </span>
  );
}
