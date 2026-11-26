import { useLocale } from "@k2b/ui";
import { Cells, Chip, Inline, Text } from "@k2b/ui/v2";
import { FETCH_BUCKET_MINUTES, type SourceFigures } from "../../contracts";
import { useScreenMessages } from "./messages";

/** Pulse's own colour, for the figure that matters today. */
const PULSE = "#1e40af";

/**
 * The one statement of the sources page (identity B, rule 1): the values that came in today, beside it the real trend
 * of today's fetches per hour, and the exceptions as "● number word · who". One slot: it becomes the shared hero band
 * once @k2b/ui has it, without the page changing around it.
 */
export function SourcesHero(props: { figures: SourceFigures; loading: boolean; failingHref?: string }) {
  const words = useScreenMessages();
  const locale = useLocale();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const fetches = () => props.figures.fetchesToday;
  // today's fetches per hour, oldest first: the buckets of an hour summed, the running hour as far as it got
  const hourly = () => {
    const perHour = 60 / FETCH_BUCKET_MINUTES;
    const buckets = fetches()?.buckets ?? [];
    return Array.from({ length: Math.ceil(buckets.length / perHour) }, (_, hour) =>
      buckets.slice(hour * perHour, (hour + 1) * perHour).reduce((sum, bucket) => sum + bucket.ok + bucket.failed, 0),
    );
  };
  const delivering = () => Math.max(0, props.figures.active - props.figures.failingCount);
  const resting = () => props.figures.total - props.figures.active;
  return (
    <Cells>
      <Cells.Cell
        icon="activity-heartbeat"
        color={PULSE}
        label={words().todayCell}
        value={props.figures.today === null ? "—" : number(props.figures.today)}
        meta={words().sinceMidnightSeries({ series: number(props.figures.series) })}
        loading={props.loading}
      />
      <Cells.Cell
        icon="refresh"
        color={PULSE}
        label={words().fetchesTodayCell}
        value={fetches() ? words().fetchesOk({ count: number(fetches()!.ok) }) : "—"}
        meta={
          fetches()?.failed ? <Text tone="bad">{words().fetchesFailed({ count: number(fetches()!.failed) })}</Text> : words().noneFailed
        }
        trend={
          fetches() && hourly().some((value) => value > 0)
            ? {
                values: hourly(),
                label: words().fetchesTrend({ ok: number(fetches()!.ok), failed: number(fetches()!.failed) }),
              }
            : undefined
        }
        loading={props.loading}
      />
      <Cells.Cell
        icon="list-check"
        label={words().stateCell}
        // what delivers and what rests in one statement; under it only the failures carry a colour, with the name
        value={
          resting() > 0
            ? `${words().delivering({ count: number(delivering()) })} · ${words().resting({ count: number(resting()) })}`
            : words().delivering({ count: number(delivering()) })
        }
        meta={
          props.figures.failingCount > 0 ? (
            <Inline>
              {/* the count in its colour as a whole word, the name after it as text that may give way */}
              <Chip status="bad">{words().errorsCount({ count: number(props.figures.failingCount) })}</Chip>
              <Text muted>
                {props.figures.failingCount > 1
                  ? `${props.figures.failing[0]?.name ?? ""} +${number(props.figures.failingCount - 1)}`
                  : (props.figures.failing[0]?.name ?? "")}
              </Text>
            </Inline>
          ) : (
            words().noErrors
          )
        }
        href={props.failingHref}
        loading={props.loading}
      />
    </Cells>
  );
}
