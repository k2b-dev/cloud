import { useLocale } from "@k2b/ui";
import { Chip, Empty, Failed, List, Notice, type OnNavigate, Pane, Row, Section, StatusRow, Tiles } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import type { ActivityPage } from "../activity-contracts";
import type { BaseSummary, BasesResult, MarkedEntry } from "../contracts";
import { type ActivityListLine, activityDays, activityListLines } from "./activity-lines";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { entryMark, FILES_COLOR, storageMark } from "./entry-mark";
import { favoriteHref } from "./FavoritesPane";
import { favoritePlace } from "./favorite-place";
import { issueText } from "./feedback";
import { daysAgo, type HistoryEnvironment, historyRows, runDestination } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { ActivityLineRow } from "./history-v2";
import { useFilesMessages } from "./messages";
import { activityUrl, filesUrl } from "./urls";

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
  // The first row says what matters today: what this person changed today; the storages count in their section.
  const today = () => {
    const page = props.recent?.page;
    if (!page) return b().allStorage;
    const count = page.items.filter((entry) => daysAgo(entry.time, props.env) === 0).length;
    return b().v2TodayByYou({ count, more: page.next && count === page.items.length ? "+" : "" });
  };
  const unreachable = () => props.bases.filter((base) => base.status !== "existing").length;
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
    const days = activityDays(historyRows(shown.page.items, { batches: true, merge: true }), shown.opened, {
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
      <Pane
        label={b().allStorage}
        scrollKey="filesv2-overview"
        status={<StatusRow lead={today()} facts={unreachable() ? [{ value: unreachable(), after: b().v2Unreachable }] : undefined} />}
      >
        {props.issues.map((issue) => (
          <Notice tone="warn" title={t()[issue.area]}>
            {issueText(t(), issue.code)}
          </Notice>
        ))}
        <Section icon="folders" color={FILES_COLOR} title={b().storageSection} count={props.bases.length}>
          {/* Rows, not cards: a few storages fill no grid, and many stay one list that keeps only its rows in view. */}
          <List
            label={b().allStorage}
            items={props.bases}
            rowKey={(base) => base.id}
            row={(base) => (
              <Row
                mark={storageMark(base)}
                lines={[
                  baseLabel(base, b(), locale()),
                  [base.kind === "users" ? b().onlyYou : t().group, t()[base.area], base.kind === "users" ? base.name : ""]
                    .filter(Boolean)
                    .join(" · "),
                ]}
                href={filesUrl(base.id)}
                onNavigate={props.onNavigate}
                end={base.status !== "existing" ? <Chip status="warn">{t()[base.status]}</Chip> : undefined}
              />
            )}
          />
        </Section>
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
                row={(item) => <ActivityLineRow item={item} env={props.env} mode="me" bases={labels()} onToggle={toggle} />}
              />
            </Show>
          </Show>
        </Section>
      </Pane>
    </Pane.Split>
  );
}
