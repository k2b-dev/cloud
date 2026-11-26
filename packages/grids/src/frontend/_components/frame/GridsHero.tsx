import { Band, Chip, Inline, Spark, type SparkProps, type Status, Text } from "@k2b/ui/v2";
import { For, Show } from "solid-js";

/** One exception under the hero: a state with its count in words, and what it is about. */
export type HeroException = { status: Status; text: string; detail?: string };

export type GridsHeroProps = {
  /** What the figure counts, for assistive technology and as its quiet word, such as "Läufe in 24 Std.". */
  label: string;
  /** The one figure that matters on this screen today, such as "24" or "169.260 €". */
  figure: string;
  /** Quiet words after the figure: its reference and the next number that matters. */
  meta?: string;
  /** Its real history, from data the app has; none when there is none (never an invented series). */
  trend?: SparkProps;
  /** What needs attention, each once: "● 2 fehlgeschlagen · Kunde ohne Steuernummer". */
  exceptions?: readonly HeroException[];
};

/**
 * The hero of a Grids screen (direction B): one figure right under the head with its real trend beside it, the
 * exceptions on one line under it. It is the slot of DP's hero band: until the figure type (`--t-figure`, 30/34 in
 * the app's colour) lands, the figure stands in the lead type; the band replaces this component in one place.
 */
export default function GridsHero(props: GridsHeroProps) {
  return (
    <Band label={props.label}>
      <Inline>
        <Text type="lead" weight="strong">
          {props.figure}
        </Text>
        <Text muted>{props.meta ?? props.label}</Text>
        <Show when={props.trend}>{(trend) => <Spark {...trend()} />}</Show>
      </Inline>
      <Show when={props.exceptions?.length}>
        <Inline>
          <For each={props.exceptions}>
            {(exception) => (
              <>
                <Chip status={exception.status}>{exception.text}</Chip>
                <Show when={exception.detail}>
                  <Text muted>{exception.detail}</Text>
                </Show>
              </>
            )}
          </For>
        </Inline>
      </Show>
    </Band>
  );
}
