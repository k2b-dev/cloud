import { query } from "@k2b/stdlib/solid";
import { toast, useLocale } from "@k2b/ui";
import { type Action, Bar, Button, Chip, Empty, List, Notice, type OnNavigate, Row, Section, Text } from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import type { ActivityBatchContext, ActivityChain, ActivityEntry } from "../activity-contracts";
import { entryMark } from "./entry-mark";
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
  type HistoryRowModel,
  historyRows,
  hopEntry,
  hopSentence,
  isDirectory,
  type MissingCase,
  missingCase,
  type Part,
  placeOf,
  plain,
  type SearchHit,
  searchHits,
  subjectName,
  type VisibleSide,
  visible,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { ActivityRow, personOf, restoreFromTrash, SentenceText } from "./history-v2";

type Kind = "Folder" | "File" | "Item";
const kindOf = (directory: boolean | null): Kind => (directory === true ? "Folder" : directory === false ? "File" : "Item");
const name = (value: string): Part => ({ kind: "name", text: value });

export type ActivitySearchProps = {
  query: string;
  /** Projected search entries, newest first, across all loaded pages. */
  entries: readonly ActivityEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore: () => void;
  limitReached: boolean;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  /** Where the item went after an entry, re-resolved against current access. */
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  loadBatch?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
  retentionDays: number;
  /** Activity with the same filters, without the search. */
  clearHref: string;
  onNavigate?: OnNavigate;
  onChanged?: () => void;
};

/**
 * A search of Activity on v2: where a vanished item is now, how it got there, and the deed that fits. The best hit
 * leads as its own section; the other hits follow as rows.
 */
export default function ActivitySearch(props: ActivitySearchProps) {
  const h = useHistoryMessages();
  const hits = createMemo(() => searchHits(props.entries, props.query));
  const top = createMemo(() => {
    const first = hits()[0];
    const kind = first ? missingCase(first.lead) : null;
    return first && kind ? { hit: first, kind } : null;
  });
  const others = createMemo(() => (top() ? hits().slice(1) : hits()));
  // Batch context counts only loaded projected entries this person sees, never the stored batch size.
  const batchMembers = createMemo(() => {
    const members = new Map<string, Set<string>>();
    for (const entry of props.entries)
      if (entry.batchId) members.set(entry.batchId, (members.get(entry.batchId) ?? new Set()).add(entry.id));
    return members;
  });
  const batchOthers = (row: HistoryRowModel) => {
    const members = row.lead.batchId ? batchMembers().get(row.lead.batchId) : undefined;
    if (!members) return 0;
    const own = new Set(row.entries.map((entry) => entry.id));
    return [...members].filter((id) => !own.has(id)).length;
  };
  // Counts cover loaded pages only; while more exist the number is a lower bound.
  const count = () =>
    props.hasMore
      ? h().hitCountMore.replace("{count}", String(hits().length))
      : hits().length === 1
        ? h().hitCountOne
        : h().hitCount.replace("{count}", String(hits().length));
  const label = () => plain(fill(h().hitsFor, { count: [name(count())], query: props.query }));
  const clear: Action = { label: h().clearSearch, icon: "x", href: props.clearHref, onNavigate: props.onNavigate };
  return (
    <>
      <Show
        when={hits().length > 0}
        fallback={
          <Show
            when={props.hasMore || props.moreFailed}
            fallback={
              <Empty
                icon="file-search"
                text={`${h().noHitsTitle.replace("{query}", props.query)} ${h().noHitsText.replace("{days}", String(props.retentionDays))}`}
                action={clear}
              />
            }
          >
            <Empty icon="file-search" text={h().nothingVisibleYet} />
          </Show>
        }
      >
        <Show when={top()} keyed>
          {(current) => (
            <MissingHit
              hit={current.hit}
              kind={current.kind}
              label={label()}
              env={props.env}
              actions={props.actions}
              batchOthers={batchOthers}
              loadBatch={props.loadBatch}
              loadChain={props.loadChain}
              onChanged={props.onChanged}
            />
          )}
        </Show>
        <Show when={others().length > 0}>
          <Section title={top() ? h().otherHits : label()} count={others().length}>
            <List
              label={top() ? h().otherHits : label()}
              items={others()}
              rowKey={(hit) => hit.key}
              row={(hit) => <OtherHit hit={hit} env={props.env} actions={props.actions} onChanged={props.onChanged} />}
            />
          </Section>
        </Show>
      </Show>
      <Show when={props.moreFailed}>
        <Notice tone="bad" actions={[{ label: h().retry, onClick: props.onLoadMore }]}>
          {h().olderFailed}
        </Notice>
      </Show>
      <Show when={props.hasMore && !props.moreFailed}>
        <Bar
          start={<Text type="meta">{count()}</Text>}
          end={
            <Button icon="chevron-down" busy={props.loadingMore} onClick={props.onLoadMore}>
              {h().loadOlder}
            </Button>
          }
        />
      </Show>
      <Show when={props.limitReached}>
        <Notice tone="note">{h().searchLimit}</Notice>
      </Show>
    </>
  );
}

/** A trashed hit reads as its state ("is in the trash"); every other hit as its newest change. */
function OtherHit(props: { hit: SearchHit; env: HistoryEnvironment; actions?: HistoryActions; onChanged?: () => void }) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const row = createMemo(() => historyRows([props.hit.lead], { batches: false })[0]!);
  const entry = () => props.hit.lead;
  const trashed = () => missingCase(entry()) === "trash" && visible(entry().before);
  return (
    <Show
      when={trashed() && visible(entry().before) ? (entry().before as VisibleSide) : null}
      fallback={<ActivityRow row={row()} env={props.env} actions={props.actions} mode="all" dated onChanged={props.onChanged} />}
    >
      {(before) => {
        const actor = actorOf(entry(), h(), props.env);
        const deleted = plain(
          fill(h().deletedBy, {
            date: formatDate(entry().time, locale(), props.env),
            time: formatTime(entry().time, locale(), props.env),
            by: byParts(actor, h(), props.env, entry()),
          }),
        );
        const formerly = plain(
          fill(h().formerlyIn, { path: [{ kind: "place", segments: placeOf(props.env, { kind: "side", side: before() }) }] }),
        );
        const restore = props.actions?.onRestoreTrash;
        return (
          <Row
            lines={[
              <SentenceText parts={fill(h().inTrashRow, { object: [name(subjectName(entry()) ?? "")] })} />,
              `${deleted} · ${formerly}`,
            ]}
            mark={entryMark({ name: before().name, directory: before().directory === true })}
            time={formatWhen(entry().time, locale(), h(), props.env)}
            action={
              restore
                ? {
                    label: h().restoreItem,
                    icon: "arrow-back-up",
                    onClick: async () => {
                      try {
                        await restoreFromTrash(entry(), restore, h());
                        props.onChanged?.();
                      } catch (error) {
                        toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
                      }
                    },
                  }
                : undefined
            }
          />
        );
      }}
    </Show>
  );
}

const variantKey = <K extends string>(prefix: K, kind: Kind) => `${prefix}${kind}` as `${K}${Kind}`;

/** The best hit: what it is, where it is now and why, the one or two deeds that fit, and how it got there. */
function MissingHit(props: {
  hit: SearchHit;
  kind: MissingCase;
  label: string;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  batchOthers: (row: HistoryRowModel) => number;
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  loadBatch?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
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
  const object = (): Part[] => [
    { kind: "text", text: kind() === "Folder" ? h().theFolder : kind() === "File" ? h().theFile : h().theItem },
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
  const done = () => {
    void chain.refresh();
    if (props.actions?.loadRecovery) void recovery.refresh();
    props.onChanged?.();
  };
  /** A deed of the hit: one at a time, and its failure in the server's words. */
  const deed = (label: string, icon: string, run: () => Promise<unknown> | unknown): Action => ({
    label,
    icon,
    onClick: async () => {
      try {
        await run();
        done();
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
      }
    },
  });

  const tag = () =>
    (
      ({
        trash: { status: "warn", label: h().tagTrash },
        purged: { status: "bad", label: h().tagPurged },
        outside: { status: "warn", label: h().tagOutside },
        unclear: { status: "warn", label: h().unclear },
      }) as const
    )[props.kind as "trash" | "purged" | "outside" | "unclear"] ?? { status: "ok" as const, label: h().tagMoved };

  const now = (): Part[] | string => {
    const { before, after } = lead();
    switch (props.kind) {
      case "moved": {
        const point = endpoint();
        if (point)
          return fill(chain.data()?.certainty === "verified" ? h().nowIn : h().probablyIn, {
            path: [{ kind: "place", segments: placeOf(props.env, { kind: "endpoint", endpoint: point }) }],
          });
        if (chain.error()) return h().chainFailed;
        if (!chain.data()) return h().recoveryChecking;
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
    const slots = { date: date(), time: time(), by: byParts(actor(), h(), props.env, lead()) };
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

  /** The one or two deeds the server allows now; they appear once its answer arrived. */
  const deeds = (): Action[] => {
    const actions = props.actions ?? {};
    const t = h();
    const recovered = !actions.loadRecovery || !!allowed();
    switch (props.kind) {
      case "moved": {
        const point = endpoint();
        if (!point) return [];
        return [
          ...(actions.onOpen
            ? [{ label: t.jumpThere, icon: "arrow-right", onClick: () => actions.onOpen!({ kind: "endpoint", endpoint: point }) }]
            : []),
          ...(actions.onMoveBack && recovered && (!actions.loadRecovery || allowed()?.canMoveBack)
            ? [
                deed(t.moveBack, "arrow-back-up", async () => {
                  await actions.onMoveBack!(lead(), point);
                  toast.success(t.movedBack.replace("{name}", itemName()));
                }),
              ]
            : []),
        ];
      }
      case "trash": {
        const trash = allowed()?.trash;
        return [
          ...(actions.onRestoreTrash && recovered && (!actions.loadRecovery || trash?.canRestore)
            ? [deed(t.restoreItem, "arrow-back-up", () => restoreFromTrash(lead(), actions.onRestoreTrash!, t))]
            : []),
          ...(actions.onShowTrash && trash ? [{ label: t.showInTrash, icon: "trash", onClick: () => actions.onShowTrash?.(trash) }] : []),
        ];
      }
      case "purged":
      case "outside":
        return [
          {
            label: t.copyPath,
            icon: "copy",
            onClick: async () => {
              await navigator.clipboard.writeText(copyValue());
              toast.success(t.pathCopied);
            },
          },
        ];
      case "unclear": {
        const place = allowed()?.oldLocation;
        return [
          ...(actions.onRecheck ? [deed(t.recheck, "refresh", () => actions.onRecheck!(lead()))] : []),
          ...(actions.onOpenOldLocation && place
            ? [{ label: t.openOldLocation, icon: "folder", onClick: () => actions.onOpenOldLocation?.(place) }]
            : []),
        ];
      }
      case "hidden": {
        const person = actor().person;
        return actions.onContact && person?.userId && lead().actor.name
          ? [
              {
                label: t.messageTo.replace("{name}", person.name),
                icon: "message",
                onClick: () => actions.onContact?.({ userId: person.userId!, name: person.name }),
              },
            ]
          : [];
      }
    }
  };
  const twoDeeds = () => deeds().slice(0, 2) as [Action] | [Action, Action];

  /* The chain: this item's loaded entries plus later hops the reader resolved, newest first. */
  const known = createMemo(() => new Set(props.hit.entries.map((entry) => entry.id)));
  const hops = createMemo(() => (chain.data()?.hops ?? []).filter((hop) => !known().has(hop.activityId) && visible(hop.after)).reverse());
  const rows = createMemo(() => historyRows(props.hit.entries, { batches: false }));
  const mark = () => entryMark({ name: itemName(), directory: directory() !== false });

  return (
    <>
      <Section
        icon={mark().icon}
        color={mark().color}
        title={itemName()}
        actions={deeds().length ? twoDeeds() : undefined}
        summary={
          <>
            <Chip status={tag().status}>{tag().label}</Chip>{" "}
            <Show when={typeof now() === "string"} fallback={<SentenceText parts={now() as Part[]} />}>
              {now() as string}
            </Show>
          </>
        }
      >
        <Show when={why()}>{(parts) => <Row icon="info-circle" lines={[<SentenceText parts={parts()} />, props.label]} />}</Show>
        <Show when={props.kind === "moved" && chain.error()}>
          <Notice tone="bad" actions={[{ label: h().retry, onClick: () => void chain.refresh() }]}>
            {h().chainFailed}
          </Notice>
        </Show>
        <Show when={needsRecovery() && recovery.error()}>
          <Notice tone="bad" actions={[{ label: h().retry, onClick: () => void recovery.refresh() }]}>
            {h().recoveryFailed}
          </Notice>
        </Show>
        <Show when={note()}>
          {(parts) => (
            <Notice tone="note">
              <SentenceText parts={parts()} />
            </Notice>
          )}
        </Show>
      </Section>
      <Section title={kind() === "Folder" ? h().folderHistory : kind() === "File" ? h().fileHistory : h().itemHistory}>
        <For each={hops()}>
          {(hop) => (
            <Row
              avatar={personOf(actorOf(hopEntry(hop), h(), props.env))}
              lines={[<SentenceText parts={hopSentence(hop, h(), props.env)} />, formatWhen(hop.time, locale(), h(), props.env)]}
            />
          )}
        </For>
        <For each={rows()}>
          {(row) => (
            <ChainRow row={row} env={props.env} actions={props.actions} loadedOthers={props.batchOthers(row)} loadBatch={props.loadBatch} />
          )}
        </For>
      </Section>
    </>
  );
}

/** A step of the hit's history; the hit above owns the deeds. A batched step counts its freshly authorized peers. */
function ChainRow(props: {
  row: HistoryRowModel;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  loadedOthers: number;
  loadBatch?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
}) {
  const h = useHistoryMessages();
  const batch = query.create({
    source: () => props.row.lead.id,
    enabled: () => !!props.row.lead.batchId && !!props.loadBatch,
    load: (_id, { abortSignal }) => props.loadBatch!(props.row.lead, abortSignal),
  });
  const others = () => {
    const result = batch.data();
    const count = result ? Math.max(0, result.visibleCount - 1) : props.loadBatch ? 0 : props.loadedOthers;
    return count ? (result?.complete ? h().withOthers : h().withAtLeastOthers).replace("{count}", String(count)) : undefined;
  };
  return <ActivityRow row={props.row} env={props.env} actions={props.actions} mode="all" context="chain" dated note={others()} deedless />;
}
