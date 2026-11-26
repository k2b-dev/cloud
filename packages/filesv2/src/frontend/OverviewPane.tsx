import { formatFileViewSize, useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Failed, List, type OnNavigate, Pane, Row, Section, Table, Text } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ActivityPage } from "../activity-contracts";
import type { BaseSummary, BasesResult, MarkedEntry, StorageFacts } from "../contracts";
import { type ActivityListLine, activityDays, activityListLines } from "./activity-lines";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { entryMark, storageMark } from "./entry-mark";
import { favoriteHref } from "./FavoritesPane";
import { favoritePlace } from "./favorite-place";
import {
  actorOf,
  daysAgo,
  formatDate,
  formatTime,
  formatWhen,
  type HistoryEnvironment,
  historyRows,
  runDestination,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { ActivityLineRow, personOf } from "./history-v2";
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
  /** Who changed each storage last, what it holds and how many belong to it; a part that failed is null. */
  facts: StorageFacts;
  /** Reads the facts again, which may count a storage the first picture had no count for. */
  loadFacts?: (signal: AbortSignal) => Promise<StorageFacts>;
  env: HistoryEnvironment;
  onNavigate: OnNavigate;
  onRetry: () => void;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const labels = createMemo(() => props.bases.map((base) => ({ id: base.id, label: baseLabel(base, b(), locale()) })));
  // The facts the page brought; where a storage had no count yet, the route is asked once after the first picture
  // (the page itself never walks a storage). Only the cells of the new counts change, the rows keep their place.
  const [facts, setFacts] = createSignal(props.facts);
  createEffect(() => setFacts(props.facts));
  onMount(() => {
    if (!props.facts.usagePending || !props.loadFacts) return;
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    props
      .loadFacts(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setFacts(next);
      })
      .catch(() => undefined);
  });
  // each fact by its storage; a storage without one shows "—" in that cell
  const byBase = <T extends { baseId: string }>(items: readonly T[] | null) => new Map((items ?? []).map((item) => [item.baseId, item]));
  const changes = createMemo(() => byBase(facts().changes));
  const usage = createMemo(() => byBase(facts().usage));
  const members = createMemo(() => byBase(facts().members));
  const kind = (base: BaseSummary) => {
    if (base.kind === "users") return b().onlyYou;
    const count = members().get(base.id)?.members;
    return count === undefined ? "—" : b().v2GroupMembers(count);
  };
  const used = (base: BaseSummary) => {
    const value = usage().get(base.id);
    if (!value) return "—";
    const size = formatFileViewSize(value.bytes, locale());
    // a count that stopped at its limit is a lower bound
    return value.complete ? size : `≥ ${size}`;
  };
  const lastBy = (base: BaseSummary) => {
    const change = changes().get(base.id);
    // the table names who changed what the storage holds; its action is not shown, so it is read as an edit
    return change ? actorOf({ actor: change.actor, via: change.via, action: "file.edit" }, h(), props.env) : null;
  };
  const lastWhen = (base: BaseSummary) => {
    const change = changes().get(base.id);
    if (!change) return "—";
    // the short form fits the column at 1024: today its time, yesterday the word, before that the day
    const ago = daysAgo(change.time, props.env);
    return ago === 0
      ? formatTime(change.time, locale(), props.env)
      : ago === 1
        ? h().yesterday.toLocaleLowerCase(locale())
        : formatDate(change.time, locale(), props.env);
  };
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
        {/* an area that could not be read is an exception of one line, not a box (B): its state, what it means, and the
            way to read it again. It speaks of the area, not of "the storage", so it never seems to mean a storage the
            list shows */}
        {props.issues.map((issue) => (
          <Bar
            start={
              // one line, as B: the state as a word and the way to read it again ("● FreeIPA-Ablagen fehlen")
              <Chip status="warn">{b().v2AreaMissing({ area: t()[issue.area] })}</Chip>
            }
            end={
              <Button variant="text" onClick={() => props.onRetry()}>
                {h().retry}
              </Button>
            }
          />
        ))}
        {/* The storages as a table (Valentin 26.11.: dense, not the sidebar again): what each is, who belongs to it,
            what it holds and who changed it last. On the phone each is a row of two lines. A storage that is not
            there says so with its chip. */}
        {/* plain section heads (B): a symbol without its tinted tile; the table's first column is "Name", never the
            section's word again */}
        <Section icon="folders" title={t().storage} count={props.bases.length}>
          <Table
            label={b().allStorage}
            rows={props.bases}
            rowKey={(base) => base.id}
            open={(base) => ({ href: filesUrl(base.id), onNavigate: props.onNavigate })}
            phone={(base) => ({
              // the facts it has; a fact that is missing is left out, not shown as a dash in the middle of a line
              lines: [baseLabel(base, b(), locale()), [kind(base), used(base)].filter((fact) => fact !== "—").join(" · ") || "—"],
              mark: storageMark(base),
              time: changes().get(base.id) ? lastWhen(base) : undefined,
              marks: base.status !== "existing" ? <Chip status="warn">{t()[base.status]}</Chip> : undefined,
            })}
            columns={[
              {
                // the wide column (B): a name is cut last; the table gives the rest of the row to its last column
                title: t().name,
                width: { min: 140, default: 240 },
                mark: (base) => storageMark(base),
                cell: (base) => baseLabel(base, b(), locale()),
              },
              {
                // who belongs to it; one that is not there says so here, in a column with room for its chip
                title: b().v2People,
                width: { min: 96, default: 104 },
                drop: true,
                cell: (base) => (base.status !== "existing" ? <Chip status="warn">{t()[base.status]}</Chip> : kind(base)),
              },
              { title: b().v2Used, width: { min: 84, default: 92 }, align: "end", drop: true, cell: (base) => used(base) },
              {
                title: b().v2LastChange,
                width: { min: 150, default: 170 },
                drop: true,
                avatar: (base) => {
                  const actor = lastBy(base);
                  return actor ? personOf(actor) : undefined;
                },
                cell: (base) => {
                  const actor = lastBy(base);
                  return actor ? `${actor.person?.name ?? actor.label} · ${lastWhen(base)}` : lastWhen(base);
                },
              },
            ]}
          />
        </Section>
        <Section
          icon="star"
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
              <Show when={favorites().items.length} fallback={<Text type="meta">{b().noFavoritesInline}</Text>}>
                {/* flat rows with their type's sign, as the recently opened beside them; nothing in a card (B) */}
                <List label={b().favorites}>
                  {favorites().items.map((item) => (
                    <Row
                      mark={entryMark(item.entry)}
                      lines={[item.entry.name, favoritePlace(item, labels())]}
                      href={favoriteHref(item)}
                      onNavigate={props.onNavigate}
                    />
                  ))}
                </List>
              </Show>
            )}
          </Show>
        </Section>
        <Show when={props.recent?.opened.length}>
          {/* what this person opened last, as tiles beside the favorites: the way back to the work of the last days */}
          <Section icon="clock" title={b().v2RecentlyOpened} count={props.recent!.opened.slice(0, FAVORITES_PREVIEW).length}>
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
        {/* the way to all of it only where there is something (B) */}
        <Section
          icon="history"
          title={b().recentByYou}
          more={
            recent().length ? { label: b().showAllActivity, href: activityUrl({ actor: "me" }), onNavigate: props.onNavigate } : undefined
          }
        >
          <Show when={props.recent} fallback={<Failed text={b().recentFailed} onRetry={props.onRetry} />}>
            <Show when={recent().length} fallback={<Text type="meta">{b().noRecentByYou}</Text>}>
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
