import { useLocale } from "@k2b/ui";
import { Cells, Chip, Disclosure, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { SpacePulse as Pulse } from "@/overview-contracts";
import { useSpaceMessages } from "../../messages";

/**
 * The one hero of a Space (identity B): the tasks the team finished in 14 days with their real trend, in the Space's
 * colour, what is overdue as the exception, and the open tasks that nobody holds. It stands above the list, table and
 * board; the calendar's grid is its own hero.
 *
 * k2b-ui gap (DP, hero band): the study's band (oauth-b) sets the figure in --t-figure 600 30/34 in the owner's ink,
 * its label 500 14/20 under it, a chart 56 px high beside it with a 12 px caption, and the exceptions as one line
 * ("● 1 overdue · 3 open without anyone") under a 1 px n100 rule, padding 18 20 14, gaps 14/32. Cells set the value
 * in 600 18/24, the spark 20 px high at the value's end, and stack the cells on the phone.
 */
export default function SpacePulse(props: { pulse: Pulse; color: string | null; description?: string | null }) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const total = () => props.pulse.done.reduce((sum, value) => sum + value, 0);
  return (
    <>
      <Cells>
        <Cells.Cell
          icon="circle-check"
          color={props.color ?? undefined}
          label={t.pulseDone}
          value={number(total())}
          trend={{
            values: props.pulse.done,
            label: t.pulseDoneTrend({ total: number(total()), today: number(props.pulse.done.at(-1) ?? 0) }),
          }}
          // Nothing overdue is no exception: no red and no "0 overdue".
          meta={props.pulse.overdue > 0 ? <Chip status="bad">{t.pulseOverdue({ count: number(props.pulse.overdue) })}</Chip> : undefined}
        />
        <Cells.Cell icon="user-question" label={t.pulseUnassigned} value={number(props.pulse.unassigned)} />
      </Cells>
      {/* The Space's description, once, as a quiet line of the band that opens to the whole text (coordinator, 28.11.); a
        Space without one shows no line and keeps no room. k2b-ui gap: a Disclosure title cannot be one quiet meta line cut
        with "…", so the line names "About this Space" and the description opens under it. */}
      <Show when={props.description?.trim()}>
        {(description) => (
          <Disclosure title={t.pulseAbout}>
            <Text>{description()}</Text>
          </Disclosure>
        )}
      </Show>
    </>
  );
}
