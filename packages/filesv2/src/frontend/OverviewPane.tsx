import { useLocale } from "@k2b/ui";
import { Empty, Failed, List, Notice, type OnNavigate, Pane, Row, Section, Tiles } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import type { ActivityPage } from "../activity-contracts";
import type { BaseSummary, BasesResult, MarkedEntry } from "../contracts";
import { type ActivityListLine, activityDays, activityListLines } from "./activity-lines";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { entryMark, FILES_COLOR } from "./entry-mark";
import { favoriteHref } from "./FavoritesPane";
import { favoritePlace } from "./favorite-place";
import { issueText } from "./feedback";
import { formatWhen, type HistoryEnvironment, historyRows, runDestination } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { ActivityLineRow } from "./history-v2";
import { useFilesMessages } from "./messages";
import { activityUrl } from "./urls";

/** The overview shows this many favorites; the page lists all of them. */
export const FAVORITES_PREVIEW = 6;
/** The last few things this person did. */
export const RECENT_LINES = 5;

/** What the server read for the overview's last part: this person's newest changes and the files they opened. */
export type RecentByYou = { page: ActivityPage; opened: readonly MarkedEntry[] };

/**
 * "All storage" on v2: every storage this person reaches as a card, their favorites, and the last few things they did.
 * The server reads all three for the first picture; each part that failed says so in its place.
 */
export default function OverviewPane(props: {
  bases: readonly BaseSummary[];
  issues: BasesResult["issues"];
  /** Authorized favorites preview; `null` when it failed. */
  favorites: { items: readonly MarkedEntry[]; more: boolean } | null;
  /** This person's last changes and opened files; `null` when they could not be read. */
  recent: RecentByYou | null;
  env: HistoryEnvironment;
  onNavigate: OnNavigate;
  onRetry: () => void;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const labels = createMemo(() => props.bases.map((base) => ({ id: base.id, label: baseLabel(base, b(), locale()) })));
  // runs this page opened; opening is presentation only, so a reload starts closed
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // The last few things this person did, in the one row design of Activity: under their day, each with its mark.
  const recent = createMemo((): ActivityListLine[] => {
    const shown = props.recent;
    if (!shown) return [];
    // the opened files stand on the left as tiles of their own; the right column keeps the changes
    const days = activityDays(historyRows(shown.page.items, { batches: true, merge: true }), [], {
      complete: !shown.page.next,
      locale: locale(),
      t: h(),
      env: props.env,
    });
    let left = RECENT_LINES;
    const first = days
      .map((day) => {
        const items = day.items.slice(0, left);
        left -= items.length;
        return { ...day, items };
      })
      .filter((day) => day.items.length > 0);
    return activityListLines(first, open(), (rows) => !!runDestination(rows, props.env));
  });

  return (
    // Two columns: the storages and favorites, and beside them what this person did last; on the phone one under the other.
    <Pane.Split>
      {/* no statement row: "Heute 5 Änderungen von dir" gave nothing to act on (Valentin 26.11.); a storage that is
          not there says so with its own chip */}
      <Pane label={b().allStorage} scrollKey="filesv2-overview">
        {props.issues.map((issue) => (
          <Notice tone="warn" title={t()[issue.area]}>
            {/* an area that could not be read has no storage of its own in the list: the notice speaks of the area,
                not of "the storage", so it never seems to mean a storage the list shows */}
            {issueText(t(), issue.code, b().v2AreaUnread({ area: t()[issue.area] }))}
          </Notice>
        ))}
        {/* no list of the storages: the sidebar names them; the dense table with usage, people and last change comes with
            its data (Valentin 26.11.) */}
        <Section
          icon="star"
          color="#ca8a04"
          title={b().favorites}
          count={props.favorites?.items.length ? `${props.favorites.items.length}${props.favorites.more ? "+" : ""}` : undefined}
          more={
            props.favorites?.items.length
              ? { label: b().showAllFavorites, href: "/app/filesv2?view=favorites", onNavigate: props.onNavigate }
              : undefined
          }
        >
          <Show when={props.favorites} fallback={<Failed text={b().favoritesFailed} onRetry={props.onRetry} />}>
            {(favorites) => (
              <Show when={favorites().items.length} fallback={<Empty icon="star" text={b().noFavoritesInline} />}>
                <Tiles
                  label={b().favorites}
                  items={favorites().items.map((item) => ({
                    ...entryMark(item.entry),
                    title: item.entry.name,
                    meta: favoritePlace(item, labels()),
                    href: favoriteHref(item),
                    onNavigate: props.onNavigate,
                  }))}
                />
              </Show>
            )}
          </Show>
        </Section>
        <Show when={props.recent?.opened.length}>
          {/* what this person opened last, as tiles beside the favorites: the way back to the work of the last days */}
          <Section
            icon="clock"
            color={FILES_COLOR}
            title={b().v2RecentlyOpened}
            count={props.recent!.opened.slice(0, FAVORITES_PREVIEW).length}
          >
            {/* rows, not tiles: a few files fill the column, and on the phone no tile stands alone in its row */}
            <List label={b().v2RecentlyOpened}>
              {props.recent!.opened.slice(0, FAVORITES_PREVIEW).map((item) => (
                <Row
                  mark={entryMark(item.entry)}
                  lines={[item.entry.name, favoritePlace(item, labels())]}
                  time={formatWhen(item.markedAt, locale(), h(), props.env)}
                  href={favoriteHref(item)}
                  onNavigate={props.onNavigate}
                />
              ))}
            </List>
          </Section>
        </Show>
      </Pane>
      <Pane label={b().recentByYou} side width={{ min: 320, default: 400 }} scrollKey="filesv2-overview-recent">
        <Section
          icon="history"
          color={FILES_COLOR}
          title={b().recentByYou}
          more={{ label: b().showAllActivity, href: activityUrl({ actor: "me" }), onNavigate: props.onNavigate }}
        >
          <Show when={props.recent} fallback={<Failed text={b().recentFailed} onRetry={props.onRetry} />}>
            <Show when={recent().length} fallback={<Empty icon="history" text={b().noRecentByYou} />}>
              <List
                label={b().recentByYou}
                items={recent()}
                rowKey={(item) => item.key}
                group={(item) => ({ key: item.day.key, label: item.day.label })}
                row={(item) => <ActivityLineRow item={item} env={props.env} mode="me" notes bases={labels()} onToggle={toggle} />}
              />
            </Show>
          </Show>
        </Section>
      </Pane>
    </Pane.Split>
  );
}
