import { useLocale } from "@k2b/ui";
import {
  Digest,
  type ActivityEntry as DigestActivity,
  Empty,
  Failed,
  Notice,
  type OnNavigate,
  Pane,
  Section,
  StatusRow,
  Tiles,
} from "@k2b/ui/v2";
import { createMemo, onCleanup, onMount, Show } from "solid-js";
import type { ActivityPage } from "../activity-contracts";
import type { BaseSummary, BasesResult, MarkedEntry } from "../contracts";
import { activityDays } from "./activity-lines";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { entryMark, FILES_COLOR, storageMark } from "./entry-mark";
import { favoriteHref } from "./FavoritesPane";
import { favoritePlace } from "./favorite-place";
import { issueText } from "./feedback";
import {
  actorOf,
  fill,
  formatWhen,
  type HistoryEnvironment,
  historyRows,
  isDirectory,
  noteSentence,
  runSentence,
  sentence,
  subjectName,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { personOf, SentenceText } from "./history-v2";
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
  // Files are uploaded inside a storage; a file dropped here is refused rather than opened by the browser.
  onMount(() => {
    const refuse = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    addEventListener("dragover", refuse);
    addEventListener("drop", refuse);
    onCleanup(() => {
      removeEventListener("dragover", refuse);
      removeEventListener("drop", refuse);
    });
  });
  const unreachable = () => props.bases.filter((base) => base.status !== "existing").length;
  // The opened files are this person's own; their name comes from their own changes, else "Me".
  const me = () => props.recent?.page.items.find((entry) => entry.actor.kind === "user" && entry.actor.name)?.actor.name ?? h().whoMe;
  const recent = createMemo((): DigestActivity[] => {
    const shown = props.recent;
    if (!shown) return [];
    const days = activityDays(historyRows(shown.page.items, { batches: true, merge: true }), shown.opened, {
      complete: !shown.page.next,
      locale: locale(),
      t: h(),
      env: props.env,
    });
    return days
      .flatMap((day) => day.items)
      .slice(0, RECENT_LINES)
      .map(({ item }): DigestActivity => {
        if (item.kind === "opened") {
          const mark = entryMark(item.item.entry);
          return {
            person: { name: me() },
            text: (
              <SentenceText
                parts={fill(h().v2Opened, { object: [{ kind: "name", text: item.item.entry.name }] })}
                mark={{ name: item.item.entry.name, mark }}
              />
            ),
            time: formatWhen(item.item.markedAt, locale(), h(), props.env),
            place: favoritePlace(item.item, labels()),
            href: favoriteHref(item.item),
          };
        }
        const rows = item.kind === "run" ? item.rows : [item.row];
        const lead = rows[0]!.lead;
        const parts =
          item.kind === "run"
            ? runSentence(rows, h(), props.env, locale())
            : (noteSentence(rows[0]!, h(), props.env, { links: true }) ??
              sentence(rows[0]!, h(), props.env, { context: "activity", links: true }));
        const subject = subjectName(lead);
        const href = parts.find((part): part is Extract<typeof part, { kind: "name" }> => part.kind === "name" && !!part.href)?.href;
        return {
          person: personOf(actorOf(lead, h(), props.env)),
          text: (
            <SentenceText
              parts={parts}
              mark={
                subject && item.kind !== "run"
                  ? { name: subject, mark: entryMark({ name: subject, directory: isDirectory(lead) === true }) }
                  : null
              }
            />
          ),
          time: formatWhen(lead.time, locale(), h(), props.env),
          href,
        };
      });
  });

  return (
    <Pane
      label={b().allStorage}
      scrollKey="filesv2-overview"
      status={
        <StatusRow
          lead={b().v2StorageCount({ count: props.bases.length })}
          facts={unreachable() ? [{ value: unreachable(), after: b().v2Unreachable }] : undefined}
        />
      }
    >
      {props.issues.map((issue) => (
        <Notice tone="warn" title={t()[issue.area]}>
          {issueText(t(), issue.code)}
        </Notice>
      ))}
      <Section icon="folders" color={FILES_COLOR} title={b().storageSection} count={props.bases.length} summary={b().createInStorage}>
        <Tiles
          variant="card"
          label={b().allStorage}
          items={props.bases.map((base) => ({
            ...storageMark(base),
            title: baseLabel(base, b(), locale()),
            href: filesUrl(base.id),
            onNavigate: props.onNavigate,
            stats: [
              { icon: base.kind === "users" ? "lock" : "users", label: base.kind === "users" ? b().onlyYou : t().group },
              { label: t()[base.area] },
              ...(base.status !== "existing" ? [{ label: t()[base.status], status: "warn" as const }] : []),
            ],
            foot: base.kind === "users" ? base.name : undefined,
          }))}
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
      <Section
        icon="history"
        color={FILES_COLOR}
        title={b().recentByYou}
        more={{ label: b().showAllActivity, href: activityUrl({ actor: "me" }), onNavigate: props.onNavigate }}
      >
        <Show when={props.recent} fallback={<Failed text={b().recentFailed} onRetry={props.onRetry} />}>
          <Show when={recent().length} fallback={<Empty icon="history" text={b().noRecentByYou} />}>
            <Digest label={b().recentByYou} activity={recent()} />
          </Show>
        </Show>
      </Section>
    </Pane>
  );
}
