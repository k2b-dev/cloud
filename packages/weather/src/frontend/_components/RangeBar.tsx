import { temperatureColor } from "../weather-scale";

/**
 * A day's temperatures as a bar from its low to its high on the week's one scale, coloured cold to warm along the way,
 * so the week reads at a glance: a cold day sits left and blue, a warm one right and orange.
 *
 * k2b-ui gap: a range bar (a value from–to on a shared domain, with colour stops) is not a primitive yet; `Progress`
 * fills only from zero. Until it is, the bar is drawn here with the weather scale.
 */
export default function RangeBar(props: { low: number; high: number; domain: readonly [number, number]; label: string }) {
  const span = () => Math.max(1, props.domain[1] - props.domain[0]);
  const at = (value: number) => ((value - props.domain[0]) / span()) * 100;
  // the colour runs along the degrees of the bar, in steps fine enough to read as one run
  const gradient = () => {
    const steps = 6;
    const colors = Array.from({ length: steps + 1 }, (_, index) =>
      temperatureColor(props.low + ((props.high - props.low) * index) / steps),
    );
    return `linear-gradient(to right, ${colors.join(", ")})`;
  };
  return (
    <span
      role="img"
      aria-label={props.label}
      style={{
        display: "block",
        position: "relative",
        height: "6px",
        "min-width": "64px",
        "border-radius": "3px",
        background: "var(--k2-n100)",
      }}
    >
      {/* in forced colours backgrounds give way: the transparent border then draws the bar's outline */}
      <span
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${at(props.low)}%`,
          width: `${Math.max(2, at(props.high) - at(props.low))}%`,
          "border-radius": "3px",
          border: "1px solid transparent",
          "box-sizing": "border-box",
          background: gradient(),
        }}
      />
    </span>
  );
}
