import { For } from "solid-js";

/**
 * New connections per day as a chart across the whole width of its place: one bar per day, the days without any a
 * sliver, today in full colour and the days before in a soft tone of it, with the first day, the middle and "today"
 * under it. A drawing of its own in a `Canvas` (k2b-ui gap: the hero band of @k2b/ui brings a chart of this size; this
 * one goes when it lands). It reads no v2 token: its colour is the owning app's, given as a hex colour.
 */
export function DayBars(props: {
  values: readonly number[];
  color: string;
  /** The words under the bars: the first day, the middle day, today. */
  axis: readonly [string, string, string];
  /** What the bars say as one sentence, for a person who cannot see them. */
  label: string;
}) {
  const width = 460;
  const height = 64;
  const gap = 3;
  const top = () => Math.max(...props.values, 1);
  const bar = () => (width - gap * (props.values.length - 1)) / Math.max(1, props.values.length);
  return (
    <div class="oauth-day-bars">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
        <For each={props.values}>
          {(value, index) => {
            const h = value > 0 ? Math.max(2, (value / top()) * height) : 1;
            const last = index() === props.values.length - 1;
            return (
              <rect
                x={(index() * (bar() + gap)).toFixed(2)}
                y={(height - h).toFixed(2)}
                width={bar().toFixed(2)}
                height={h.toFixed(2)}
                rx="1.5"
                fill={props.color}
                fill-opacity={value === 0 ? 0.15 : last ? 1 : 0.32}
              />
            );
          }}
        </For>
      </svg>
      <p class="oauth-day-bars-axis" aria-hidden="true">
        <span>{props.axis[0]}</span>
        <span>{props.axis[1]}</span>
        <span>{props.axis[2]}</span>
      </p>
    </div>
  );
}
