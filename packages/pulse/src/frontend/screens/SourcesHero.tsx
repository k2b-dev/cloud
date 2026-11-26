import { useLocale } from "@k2b/ui";
import { Band, Canvas } from "@k2b/ui/v2";
import type { SourceFigures } from "../../contracts";
import { useScreenMessages } from "./messages";
import { type HeroException, SourcesHeroDrawing } from "./sources-drawings";

/**
 * The one statement of the sources page (identity B, rule 1): the values that came in today, beside it today's
 * fetches per ten minutes (red where one failed), and under both the exceptions as "● number word · who". One slot:
 * the Band with its drawing becomes the shared hero band once @k2b/ui has it, without the page changing around it.
 */
export function SourcesHero(props: {
  figures: SourceFigures;
  /** The clock time now in the base's zone, the chart's end. */
  now: string;
  /** A time as its clock time in the base's zone, for "seit 10:40". */
  clock: (value: string) => string;
  /** The base's alerts that need a look, as one exception that opens their list. */
  alerts?: { count: number; name: string; critical: boolean; href: string };
}) {
  const words = useScreenMessages();
  const locale = useLocale();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const fetches = () => props.figures.fetchesToday;
  const paused = () => props.figures.total - props.figures.active;
  const delivering = () => Math.max(0, props.figures.active - props.figures.failingCount - props.figures.waiting);
  const exceptions = (): HeroException[] => {
    const first = props.figures.failing[0];
    const failing: HeroException[] =
      props.figures.failingCount > 0
        ? [
            {
              tone: "bad",
              count: number(props.figures.failingCount),
              word: words().errorWord,
              meta: first
                ? [
                    first.since ? words().failingSince({ name: first.name, time: props.clock(first.since) }) : first.name,
                    props.figures.failingCount > 1 ? `+${number(props.figures.failingCount - 1)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : undefined,
            },
          ]
        : [];
    const resting = paused() + props.figures.waiting;
    const alerts: HeroException[] = props.alerts
      ? [
          {
            tone: props.alerts.critical ? "bad" : "warn",
            count: number(props.alerts.count),
            word: words().alertsWord,
            meta: props.alerts.count > 1 ? `${props.alerts.name} +${number(props.alerts.count - 1)}` : props.alerts.name,
            href: props.alerts.href,
          },
        ]
      : [];
    return [
      { tone: "ok", count: number(delivering()), word: words().deliverWord },
      ...failing,
      ...alerts,
      ...(resting > 0
        ? [
            {
              tone: "off" as const,
              count: number(resting),
              word: words().restWord,
              meta: [
                paused() > 0 ? words().pausedCount({ count: number(paused()) }) : "",
                props.figures.waiting > 0 ? words().newCount({ count: number(props.figures.waiting) }) : "",
              ]
                .filter(Boolean)
                .join(" · "),
            },
          ]
        : []),
    ];
  };
  return (
    <Band label={words().todayCell}>
      <Canvas label={words().todayCell}>
        <SourcesHeroDrawing
          figure={props.figures.today === null ? "—" : number(props.figures.today)}
          label={words().todayCell}
          meta={words().sinceMidnightSeries({ series: number(props.figures.series) })}
          buckets={fetches()?.buckets ?? []}
          start="00:00"
          caption={
            fetches() ? words().fetchesCaption({ ok: number(fetches()!.ok), failed: number(fetches()!.failed) }) : words().fetchesUnknown
          }
          end={props.now}
          chartLabel={
            fetches() ? words().fetchesTrend({ ok: number(fetches()!.ok), failed: number(fetches()!.failed) }) : words().fetchesUnknown
          }
          exceptions={exceptions()}
        />
      </Canvas>
    </Band>
  );
}
