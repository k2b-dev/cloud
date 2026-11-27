import { Text, useLocale } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { areaListMessages } from "./messages";

// k2b-ui gap: virtual Table (MW, #4211). Until it lands, a list that can grow without bound renders its first rows and
// a search reaches the rest.

/** How many rows such a list renders at most. */
export const ROW_CAP = 100;

/** The first `ROW_CAP` rows; the list itself while it is shorter. */
export const capped = <T,>(rows: readonly T[]): readonly T[] => (rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows);

/**
 * The calm line under a capped list, "100 von 1.000 · Suche eingrenzen", with the counts in the page's locale; nothing
 * while every row shows.
 */
export function CappedNote(props: { total: number }) {
  const locale = useLocale();
  const t = () => areaListMessages.resolve([locale()]).t;
  return (
    <Show when={props.total > ROW_CAP}>
      <Text type="meta" muted>
        {`${t().shownOf({ shown: ROW_CAP.toLocaleString(locale()), total: props.total.toLocaleString(locale()) })} · ${t().narrowSearch}`}
      </Text>
    </Show>
  );
}
