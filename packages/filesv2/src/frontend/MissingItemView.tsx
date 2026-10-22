import { query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CopyButton,
  FileTypeIcon,
  Placeholder,
  Skeleton,
  StatusBadge,
  type StatusTone,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import type { ActivityChain, ActivityEntry } from "../activity-contracts";
import { HistoryAvatar, HistoryRow, MetaLine, MoreFooter, restoreFromTrash, Sentence, SkeletonRows, useRowAction } from "./ActivityView";
import {
  actorOf,
  actorParts,
  byParts,
  fill,
  formatDate,
  formatTime,
  formatWhen,
  type HistoryActions,
  type HistoryEnvironment,
  historyRows,
  hopEntry,
  hopSentence,
  isDirectory,
  type MissingCase,
  missingCase,
  type Part,
  placeOf,
  plain,
  type RowAction,
  type SearchHit,
  searchHits,
  subjectName,
  type VisibleSide,
  visible,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";

export type MissingItemViewProps = {
  query: string;
  /** Projected search entries, newest first, across all loaded pages. */
  entries: readonly ActivityEntry[];
  state: "loading" | "error" | "ready";
  onRetry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore: () => void;
  limitReached: boolean;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  /** Where the item went after an entry, re-resolved against current access. */
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  retentionDays: number;
  onClearSearch: () => void;
  onChanged?: () => void;
};

type Kind = "Folder" | "File" | "Item";
const kindOf = (directory: boolean | null): Kind => (directory === true ? "Folder" : directory === false ? "File" : "Item");
const name = (value: string): Part => ({ kind: "name", text: value });

/** History search result: where a vanished item is now, how it got there, and the action that fits. */
export default function MissingItemView(props: MissingItemViewProps) {
  const h = useHistoryMessages();
  const hits = createMemo(() => searchHits(props.entries, props.query));
  const top = createMemo(() => {
    const first = hits()[0];
    const kind = first ? missingCase(first.lead) : null;
    return first && kind ? { hit: first, kind } : null;
  });
  const others = createMemo(() => (top() ? hits().slice(1) : hits()));
  const label = () =>
    fill(h().hitsFor, {
      // Counts cover loaded pages only; while more exist the number is a lower bound.
      count: [
        name(
          props.hasMore
            ? h().hitCountMore.replace("{count}", String(hits().length))
            : hits().length === 1
              ? h().hitCountOne
              : h().hitCount.replace("{count}", String(hits().length)),
        ),
      ],
      query: props.query,
    });
  return (
    <div class="filesv2-history-result">
      <Switch>
        <Match when={props.state === "loading"}>
          <p class="filesv2-history-result__label" role="status">
            {h().searching}
          </p>
          <div class="filesv2-history-hit filesv2-history-hit--skeleton" aria-hidden="true">
            <Skeleton class="filesv2-history-skeleton__tile" />
            <div>
              <Skeleton class="filesv2-history-skeleton__title" />
              <Skeleton class="filesv2-history-skeleton__meta" />
              <Skeleton class="filesv2-history-skeleton__meta" />
            </div>
          </div>
          <Skeleton class="filesv2-history-skeleton__day" />
          <SkeletonRows count={3} variant="list" />
        </Match>
        <Match when={props.state === "error"}>
          <Placeholder
            state="error"
            icon="ti ti-alert-triangle"
            title={h().searchFailedTitle}
            description={h().searchFailedText}
            action={
              <Button variant="secondary" onClick={props.onRetry}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {h().retry}
              </Button>
            }
          />
        </Match>
        <Match when={hits().length === 0 && (props.hasMore || props.moreFailed)}>
          <p class="filesv2-history-scanned">{h().nothingVisibleYet}</p>
          <MoreFooter
            hasMore={props.hasMore}
            loadingMore={props.loadingMore}
            failed={props.moreFailed}
            limitReached={props.limitReached}
            onMore={props.onLoadMore}
          />
        </Match>
        <Match when={hits().length === 0}>
          <Placeholder
            state="no-results"
            icon="ti ti-file-search"
            title={h().noHitsTitle.replace("{query}", props.query)}
            description={h().noHitsText.replace("{days}", String(props.retentionDays))}
            action={
              <Button variant="secondary" onClick={props.onClearSearch}>
                <i class="ti ti-x" aria-hidden="true" />
                {h().clearSearch}
              </Button>
            }
          />
        </Match>
        <Match when={hits().length > 0}>
          <p class="filesv2-history-result__label">
            <Sentence parts={label()} />
          </p>
          <Show when={top()} keyed>
            {(current) => (
              <MissingHit
                hit={current.hit}
                kind={current.kind}
                env={props.env}
                actions={props.actions}
                loadChain={props.loadChain}
                onChanged={props.onChanged}
              />
            )}
          </Show>
          <Show when={others().length > 0}>
            <section class="filesv2-history-section">
              <Show when={top()}>
                <h3 class="filesv2-history-section__title">{h().otherHits}</h3>
              </Show>
              <ul class="filesv2-history-rows">
                <For each={others()}>
                  {(hit) => (
                    <li>
                      <OtherHit hit={hit} env={props.env} actions={props.actions} onChanged={props.onChanged} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <MoreFooter
            hasMore={props.hasMore}
            loadingMore={props.loadingMore}
            failed={props.moreFailed}
            limitReached={props.limitReached}
            onMore={props.onLoadMore}
          />
        </Match>
      </Switch>
    </div>
  );
}

/** A trashed hit reads as its state ("is in the trash"); every other hit as its newest change. */
function OtherHit(props: { hit: SearchHit; env: HistoryEnvironment; actions?: HistoryActions; onChanged?: () => void }) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const row = createMemo(() => historyRows([props.hit.lead], { batches: false })[0]!);
  const trashed = () => missingCase(props.hit.lead) === "trash" && visible(props.hit.lead.before);
  const sentence = () => (trashed() ? fill(h().inTrashRow, { object: [name(subjectName(props.hit.lead) ?? "")] }) : undefined);
  const meta = () => {
    const entry = props.hit.lead;
    if (!trashed() || !visible(entry.before)) return undefined;
    const actor = actorOf(entry, h(), props.env);
    return [
      {
        kind: "time" as const,
        iso: entry.time,
        text: plain(
          fill(h().deletedBy, {
            date: formatDate(entry.time, locale(), props.env),
            time: formatTime(entry.time, locale(), props.env),
            by: byParts(actor, h(), props.env, entry),
          }),
        ),
      },
      {
        kind: "text" as const,
        text: plain(
          fill(h().formerlyIn, { path: [{ kind: "place", segments: placeOf(props.env, { kind: "side", side: entry.before }) }] }),
        ),
      },
    ];
  };
  return (
    <HistoryRow
      row={row()}
      env={props.env}
      actions={props.actions}
      context="activity"
      dated={false}
      variant="list"
      sentence={sentence()}
      meta={meta()}
      onChanged={props.onChanged}
    />
  );
}

function variantKey<K extends string>(prefix: K, kind: Kind) {
  return `${prefix}${kind}` as `${K}${Kind}`;
}

function MissingHit(props: {
  hit: SearchHit;
  kind: MissingCase;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  onChanged?: () => void;
}) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const lead = () => props.hit.lead;
  const directory = createMemo(() => props.hit.entries.map(isDirectory).find((value) => value !== null) ?? null);
  const kind = () => kindOf(directory());
  const itemName = () => subjectName(lead()) ?? props.hit.entries.map(subjectName).find(Boolean) ?? "";
  const actor = createMemo(() => actorOf(lead(), h(), props.env));
  const date = () => formatDate(lead().time, locale(), props.env);
  const time = () => formatTime(lead().time, locale(), props.env);
  const by = () => byParts(actor(), h(), props.env, lead());
  const object = () => [
    { kind: "text" as const, text: kind() === "Folder" ? h().theFolder : kind() === "File" ? h().theFile : h().theItem },
  ];
  const sidePath = (side: VisibleSide): Part => ({ kind: "place", segments: placeOf(props.env, { kind: "side", side }) });
  const chain = query.create({
    source: () => lead().id,
    enabled: () => props.kind === "moved",
    load: (_id, { abortSignal }) => props.loadChain(lead(), abortSignal),
  });
  const endpoint = () => chain.data()?.endpoint ?? null;
  // Loaded beside the chain: which recovery the server allows now. Without a loader, callbacks alone decide.
  const needsRecovery = () => !!props.actions?.loadRecovery && ["moved", "trash", "unclear"].includes(props.kind);
  const recovery = query.create({
    source: () => lead().id,
    enabled: needsRecovery,
    load: (_id, { abortSignal }) => props.actions!.loadRecovery!(lead(), abortSignal),
  });
  const allowed = () => recovery.data() ?? null;
  const runner = useRowAction(() => {
    void chain.refresh();
    if (props.actions?.loadRecovery) void recovery.refresh();
    props.onChanged?.();
  });

  const tag = (): { tone: StatusTone; label: string; icon: string | null } => {
    switch (props.kind) {
      case "trash":
        return { tone: "neutral", label: h().tagTrash, icon: "ti ti-trash" };
      case "purged":
        return { tone: "error", label: h().tagPurged, icon: null };
      case "outside":
        return { tone: "warning", label: h().tagOutside, icon: "ti ti-server" };
      case "unclear":
        return { tone: "warning", label: h().unclear, icon: "ti ti-alert-triangle" };
      default:
        return { tone: "neutral", label: h().tagMoved, icon: null };
    }
  };

  const now = (): Part[] | "chain-loading" | "chain-failed" => {
    const { before, after } = lead();
    switch (props.kind) {
      case "moved": {
        const point = endpoint();
        if (point)
          return fill(chain.data()?.certainty === "verified" ? h().nowIn : h().probablyIn, {
            path: [{ kind: "place", segments: placeOf(props.env, { kind: "endpoint", endpoint: point }) }],
          });
        if (chain.error()) return "chain-failed";
        if (!chain.data()) return "chain-loading";
        // A stored snapshot names the destination but never proves it is still there.
        return visible(after) ? fill(h().movedTo, { path: [sidePath(after)] }) : fill(h().nowHidden, {});
      }
      case "trash": {
        const base = visible(before) ? placeOf(props.env, { kind: "side", side: before })[0] : undefined;
        return base ? fill(h().inTrashOf, { path: [{ kind: "place", segments: [base] }] }) : fill(h().inTrash, {});
      }
      case "purged":
        return fill(h().purgedNow, { actor: actorParts(actor(), h()), object: object(), date: date(), time: time() });
      case "outside":
        return visible(before) ? fill(h().missingAt, { path: [sidePath(before)] }) : fill(h().missing, { object: object() });
      case "unclear":
        return visible(after)
          ? fill(h().unclearNow, { actor: actorParts(actor(), h()), object: object(), to: [sidePath(after)], date: date(), time: time() })
          : fill(h().unclearNowHidden, { actor: actorParts(actor(), h()), object: object(), date: date(), time: time() });
      case "hidden":
        return fill(h().nowHidden, {});
    }
  };
  const why = (): Part[] | null => {
    const slots = { date: date(), time: time(), by: by() };
    switch (props.kind) {
      case "moved":
      case "hidden":
        return fill(lead().action === "item.rename" ? h().whyRenamed : h().whyMoved, slots);
      case "trash":
        return fill(h().whyTrash, slots);
      case "purged": {
        const trashed = props.hit.entries.find((entry) => entry.action === "item.trash" && entry.state === "done");
        if (!trashed) return null;
        return fill(h().whyPurgedTrash, {
          date: formatDate(trashed.time, locale(), props.env),
          time: formatTime(trashed.time, locale(), props.env),
          by: byParts(actorOf(trashed, h(), props.env), h(), props.env, trashed),
        });
      }
      case "outside":
        return fill(h().whyOutside, { date: date(), time: time() });
      case "unclear": {
        const change = { "item.move": h().changeMove, "item.rename": h().changeRename, "item.trash": h().changeTrash }[
          lead().action as string
        ];
        return fill(h().whyUnclear, { change: change ?? h().changeOther });
      }
    }
  };
  const oldPlace = () => (visible(lead().before) ? (lead().before as VisibleSide) : null);
  const copyValue = () => {
    const side = oldPlace();
    return side ? [...placeOf(props.env, { kind: "side", side }), side.name].join("/") : itemName();
  };
  const note = (): Part[] | null => {
    const t = h();
    const side = oldPlace();
    switch (props.kind) {
      case "trash":
        return side ? fill(t[variantKey("trashNote", kind())], { path: [sidePath(side)] }) : null;
      case "purged":
        return fill(t[variantKey("purgedNote", kind())], {});
      case "outside":
        return fill(t[variantKey("outsideNote", kind())], {});
      case "hidden": {
        const person = actor().person;
        return person ? fill(t[variantKey("hiddenNote", kind())], { actor: person.name }) : fill(t.hiddenNoteNobody, {});
      }
      case "moved":
        return endpoint() && chain.data()?.certainty === "probable" ? fill(t.probableNote, {}) : null;
      default:
        return null;
    }
  };

  const restore = async () => {
    if (props.actions?.onRestoreTrash) await restoreFromTrash(lead(), props.actions.onRestoreTrash, h());
  };
  const moveBack = async () => {
    const point = endpoint();
    if (!point || !props.actions?.onMoveBack) return;
    await props.actions.onMoveBack(lead(), point);
    toast.success(h().movedBack.replace("{name}", itemName()));
  };
  const button = (action: RowAction, primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      loading={runner.pending()}
      disabled={runner.pending()}
      onClick={() => void runner.run(action)}
    >
      <i class={action.icon} aria-hidden="true" />
      {action.label}
    </Button>
  );
  const buttons = (): JSX.Element => {
    const actions = props.actions ?? {};
    const t = h();
    switch (props.kind) {
      case "moved": {
        const point = endpoint();
        return (
          <Show when={point}>
            {(target) => (
              <>
                <Show when={actions.onOpen}>
                  {(open) => (
                    <Button variant="primary" disabled={runner.pending()} onClick={() => open()({ kind: "endpoint", endpoint: target() })}>
                      <i class="ti ti-arrow-right" aria-hidden="true" />
                      {t.jumpThere}
                    </Button>
                  )}
                </Show>
                <Show when={actions.onMoveBack && (!actions.loadRecovery || allowed()?.canMoveBack)}>
                  {button({ label: t.moveBack, icon: "ti ti-arrow-back-up", run: moveBack }, false)}
                </Show>
              </>
            )}
          </Show>
        );
      }
      case "trash":
        return (
          <>
            <Show when={actions.onRestoreTrash && (!actions.loadRecovery || allowed()?.trash?.canRestore)}>
              {button({ label: t.restoreItem, icon: "ti ti-arrow-back-up", run: restore }, true)}
            </Show>
            <Show when={actions.onShowTrash && allowed()?.trash}>
              {(trash) => (
                <Button variant="secondary" onClick={() => actions.onShowTrash?.(trash())}>
                  <i class="ti ti-trash" aria-hidden="true" />
                  {t.showInTrash}
                </Button>
              )}
            </Show>
          </>
        );
      case "purged":
      case "outside":
        return <CopyButton variant="secondary" value={copyValue()} label={t.copyPath} copiedLabel={t.pathCopied} />;
      case "unclear":
        return (
          <>
            <Show when={actions.onRecheck}>
              {(recheck) => button({ label: t.recheck, icon: "ti ti-refresh", run: () => recheck()(lead()) }, true)}
            </Show>
            <Show when={actions.onOpenOldLocation && allowed()?.oldLocation}>
              {(place) => (
                <Button variant="secondary" onClick={() => actions.onOpenOldLocation?.(place())}>
                  <i class="ti ti-folder" aria-hidden="true" />
                  {t.openOldLocation}
                </Button>
              )}
            </Show>
          </>
        );
      case "hidden": {
        const person = actor().person;
        return (
          <Show when={actions.onContact && person?.userId && lead().actor.name ? { userId: person.userId, name: person.name } : null}>
            {(contact) => (
              <Button variant="secondary" onClick={() => actions.onContact?.(contact())}>
                <i class="ti ti-message" aria-hidden="true" />
                {t.messageTo.replace("{name}", contact().name)}
              </Button>
            )}
          </Show>
        );
      }
    }
  };

  /* The chain: this item's loaded entries plus later hops the reader resolved, newest first. */
  const known = createMemo(() => new Set(props.hit.entries.map((entry) => entry.id)));
  const hops = createMemo(() => (chain.data()?.hops ?? []).filter((hop) => !known().has(hop.activityId) && visible(hop.after)).reverse());
  const rows = createMemo(() => historyRows(props.hit.entries, { batches: false }));

  return (
    <>
      <article class="filesv2-history-hit" aria-labelledby={`filesv2-hit-${lead().id}`}>
        <span class="filesv2-history-hit__tile">
          <FileTypeIcon name={itemName()} folder={directory() !== false} size="lg" />
        </span>
        <div class="filesv2-history-hit__text">
          <h3 id={`filesv2-hit-${lead().id}`} class="filesv2-history-hit__title">
            <span class="break-all">{itemName()}</span>
            <StatusBadge tone={tag().tone} icon={tag().icon} label={tag().label} />
          </h3>
          <p class="filesv2-history-hit__now">
            <Switch>
              <Match when={now() === "chain-loading"}>
                <Skeleton class="filesv2-history-skeleton__now" />
              </Match>
              <Match when={now() === "chain-failed"}>
                <span>{h().chainFailed}</span>{" "}
                <Button size="xs" variant="text" onClick={() => void chain.refresh()}>
                  {h().retry}
                </Button>
              </Match>
              <Match when={Array.isArray(now()) && (now() as Part[])}>{(parts) => <Sentence parts={parts()} />}</Match>
            </Switch>
          </p>
          <Show when={why()}>
            {(parts) => (
              <p class="filesv2-history-hit__why">
                <Sentence parts={parts()} />
              </p>
            )}
          </Show>
          <div class="filesv2-history-hit__buttons">{buttons()}</div>
          {/* Actions that need the server's current answer appear once it arrived; a failure says so beside a retry. */}
          <Show when={needsRecovery() && !recovery.data()}>
            <Show
              when={recovery.error()}
              fallback={
                <p class="filesv2-history-hit__checking" role="status">
                  {h().recoveryChecking}
                </p>
              }
            >
              <p class="filesv2-history-row__error" role="alert">
                {h().recoveryFailed}{" "}
                <Button size="xs" variant="text" onClick={() => void recovery.refresh()}>
                  {h().retry}
                </Button>
              </p>
            </Show>
          </Show>
          <Show when={runner.error()}>
            {(message) => (
              <p class="filesv2-history-row__error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Show when={note()}>
            {(parts) => (
              <p class="filesv2-history-note">
                <i class="ti ti-info-circle" aria-hidden="true" />
                <span>
                  <Sentence parts={parts()} />
                </span>
              </p>
            )}
          </Show>
        </div>
      </article>
      <section class="filesv2-history-section filesv2-history-chain">
        <h3 class="filesv2-history-section__title">
          {kind() === "Folder" ? h().folderHistory : kind() === "File" ? h().fileHistory : h().itemHistory}
        </h3>
        <ul class="filesv2-history-rows">
          <For each={hops()}>
            {(hop) => (
              <li>
                <article class="filesv2-history-row" data-variant="list">
                  <HistoryAvatar actor={actorOf(hopEntry(hop), h(), props.env)} size="sm" />
                  <div class="filesv2-history-row__text">
                    <p class="filesv2-history-row__sentence">
                      <Sentence parts={hopSentence(hop, h(), props.env)} />
                    </p>
                    <MetaLine parts={[{ kind: "time", iso: hop.time, text: formatWhen(hop.time, locale(), h(), props.env) }]} />
                  </div>
                  <div class="filesv2-history-row__action" />
                </article>
              </li>
            )}
          </For>
          <For each={rows()}>
            {(row) => (
              <li>
                <HistoryRow
                  row={row}
                  env={props.env}
                  context="chain"
                  directory={directory() ?? undefined}
                  dated={false}
                  variant="list"
                  action={null}
                  meta={undefined}
                />
              </li>
            )}
          </For>
        </ul>
      </section>
    </>
  );
}

export type MovedNoticeProps = {
  /** The move that took the item or its ancestor away from the address the person opened. */
  entry: ActivityEntry;
  chain: ActivityChain;
  /** The opened subject, when the move itself may describe an ancestor. Never an authority for the endpoint. */
  openedItem?: { name: string; directory: boolean | null };
  /** Breadcrumb of the opened address, including the item's own name. */
  oldAddress: readonly string[];
  env: HistoryEnvironment;
  actions?: Pick<HistoryActions, "onOpen">;
  historyHref?: string;
};

/** Shown instead of "Not found" when an old address points to an item that moved. Never redirects silently. */
export function MovedNotice(props: MovedNoticeProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const directory = () => (props.openedItem ? props.openedItem.directory : isDirectory(props.entry));
  const itemName = () => props.openedItem?.name ?? props.oldAddress.at(-1) ?? subjectName(props.entry) ?? "";
  const actor = createMemo(() => actorOf(props.entry, h(), props.env));
  const title = () => (directory() === true ? h().movedTitleFolder : directory() === false ? h().movedTitleFile : h().movedTitleItem);
  const now = (): Part[] => {
    const point = props.chain.endpoint;
    // A null endpoint can mean hidden, missing or interrupted evidence; it does not prove a current place.
    if (!point) return fill(h().chainFailed, {});
    const path: Part[] = [{ kind: "place", segments: placeOf(props.env, { kind: "endpoint", endpoint: point }) }];
    return fill(props.chain.certainty === "verified" ? h().movedNow : h().movedProbably, { name: itemName(), path });
  };
  return (
    <div class="filesv2-history-moved">
      <span class="filesv2-history-hit__tile">
        <FileTypeIcon name={itemName()} folder={directory() !== false} size="lg" />
      </span>
      <h2 class="filesv2-history-moved__title">{title()}</h2>
      <p class="filesv2-history-moved__now">
        <Sentence parts={now()} />
      </p>
      <p class="filesv2-history-moved__why">
        <Sentence
          parts={fill(h().whyMoved, {
            date: formatDate(props.entry.time, locale(), props.env),
            time: formatTime(props.entry.time, locale(), props.env),
            by: byParts(actor(), h(), props.env, props.entry),
          })}
        />
      </p>
      <div class="filesv2-history-hit__buttons">
        <Show when={props.chain.endpoint && props.actions?.onOpen ? props.chain.endpoint : null}>
          {(point) => (
            <Button variant="primary" onClick={() => props.actions?.onOpen?.({ kind: "endpoint", endpoint: point() })}>
              <i class="ti ti-arrow-right" aria-hidden="true" />
              {h().jumpThere}
            </Button>
          )}
        </Show>
        <Show when={props.historyHref}>
          {(href) => (
            <ButtonLink variant="secondary" href={href()}>
              <i class="ti ti-history" aria-hidden="true" />
              {h().viewHistory}
            </ButtonLink>
          )}
        </Show>
      </div>
      <p class="filesv2-history-note">
        <i class="ti ti-info-circle" aria-hidden="true" />
        <span>
          <Sentence parts={fill(h().bookmarkNote, { path: [{ kind: "place", segments: props.oldAddress }] })} />
        </span>
      </p>
    </div>
  );
}
