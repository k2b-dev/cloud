import { query } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { type Action, Mark, type MarkProps, Menu, type MenuEntry, type Person, Row, Text } from "@k2b/ui/v2";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import type { MarkedEntry } from "../contracts";
import { entryMark } from "./entry-mark";
import {
  type ActorView,
  actorOf,
  fill,
  formatTime,
  formatWhen,
  type HistoryActions,
  type HistoryEnvironment,
  type HistoryRowModel,
  isCurrent,
  isDirectory,
  type MetaPart,
  metaParts,
  noteSentence,
  type Part,
  type RestoreOutcome,
  type RowAction,
  rowAction,
  runSentence,
  sentence,
  subjectName,
} from "./history-actions";
import { type HistoryMessages, useHistoryMessages } from "./history-messages";
import { filesUrl } from "./urls";

/** v1's Tabler classes (`ti ti-refresh`) as v2 names (`refresh`). */
export const iconName = (value: string | null | undefined) => (value ?? "").replace(/^ti\s+ti-/, "") || undefined;

/**
 * Who acted, as a v2 person: a person or a delegate by the person's name, others by what they are (a link visitor,
 * Files itself, a change found on disk without an entry). Names are never stored; a deleted account says so.
 */
export function personOf(actor: ActorView): Person {
  if (actor.kind === "person" || actor.kind === "delegate") return { name: actor.person?.name ?? actor.label };
  return { name: actor.label, color: actor.kind === "observed" ? "#b45309" : "#475569" };
}

/** The thing a sentence is about wears its mark beside its name, as it does in its folder. */
const subjectMark = (entry: ActivityEntry): MarkProps | null => {
  const name = subjectName(entry);
  const directory = isDirectory(entry);
  return name ? entryMark({ name, directory: directory === true }) : null;
};

/**
 * A history sentence on v2. Names are strong, the thing itself leads with its mark, places read quietly as a path.
 * Nothing in it is a link: the row it stands in opens the thing, and a link inside an opening row would be a control
 * inside a control.
 */
export function SentenceText(props: { parts: readonly Part[]; mark?: { name: string; mark: MarkProps } | null }) {
  return (
    <For each={props.parts}>
      {(part) => (
        <Switch fallback={part.kind === "text" ? part.text : null}>
          <Match when={part.kind === "actor" && part}>{(actor) => <Text weight="strong">{actor().text}</Text>}</Match>
          <Match when={part.kind === "name" && part}>
            {(item) => (
              <>
                <Show when={props.mark && props.mark.name === item().text ? props.mark.mark : null}>{(mark) => <Mark {...mark()} />}</Show>
                <Text weight="strong">{item().text}</Text>
                <Show when={item().hint}>{(hint) => ` (${hint()})`}</Show>
              </>
            )}
          </Match>
          <Match when={part.kind === "place" && part}>{(place) => place().segments.join(" › ")}</Match>
        </Switch>
      )}
    </For>
  );
}

/** Where the first current thing of a sentence is now; the row opens it. */
const hrefOf = (parts: readonly Part[]) =>
  parts.find((part): part is Extract<Part, { kind: "name" }> => part.kind === "name" && !!part.href)?.href;

/** The quiet facts of a row as words: the state stands as a chip of its own, the time at the top right. */
export const factsText = (parts: readonly MetaPart[]) =>
  parts
    .filter((part): part is Extract<MetaPart, { kind: "text" | "via" }> => part.kind === "text" || part.kind === "via")
    .map((part) => part.text)
    .join(" · ");

/** The state of a change that did not simply finish: colour, symbol and word. */
export const stateOf = (parts: readonly MetaPart[]) =>
  parts.find((part): part is Extract<MetaPart, { kind: "status" }> => part.kind === "status");
export const stateTone = (tone: Extract<MetaPart, { kind: "status" }>["tone"]) =>
  tone === "error" ? "bad" : tone === "neutral" ? "ok" : "warn";

/**
 * Restores a trashed item to its old place. When something with the same name is there by now, asks for a new name
 * and tries again; cancelling leaves the item in the trash.
 */
export async function restoreFromTrash(
  entry: ActivityEntry,
  restore: (entry: ActivityEntry, options?: { name: string }) => Promise<RestoreOutcome>,
  h: HistoryMessages,
): Promise<void> {
  const name = subjectName(entry) ?? "";
  let outcome = await restore(entry);
  while (outcome.status === "name_conflict") {
    // k2b-ui gap: v2 has no form dialog in Files yet; the v1 prompt asks for the new name (Files PR 3).
    const values = await prompts.form({
      title: h.conflictTitle,
      icon: "ti ti-arrow-back-up",
      confirmText: h.restoreItem,
      fields: {
        name: {
          type: "text",
          label: h.newName,
          description: h.conflictText,
          default: `${name} ${h.restoredCopy}`,
          required: true,
          maxLength: 255,
        },
      },
    });
    if (!values) return;
    outcome = await restore(entry, { name: String(values.name) });
  }
  toast.success(h.restored.replace("{name}", name));
}

/** A row's one deed as a v2 action: it runs once at a time, and a failure says so with the server's words. */
export function deedOf(action: RowAction | null, h: HistoryMessages, restore: HistoryActions["onRestoreTrash"], onChanged?: () => void) {
  if (!action) return undefined;
  const trashed = action.restoresTrash;
  const run = trashed && restore ? () => restoreFromTrash(trashed, restore, h) : action.run;
  let running = false;
  const deed: Action = {
    label: action.label,
    icon: iconName(action.icon),
    onClick: async () => {
      if (running) return;
      running = true;
      try {
        await run();
        onChanged?.();
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : h.actionFailed);
      } finally {
        running = false;
      }
    },
  };
  return deed;
}

/** The other deeds of a row behind its "…": the run that made the change, and a message to who made it. */
function moreDeeds(
  entry: ActivityEntry,
  actor: ActorView,
  h: HistoryMessages,
  env: HistoryEnvironment,
  actions?: HistoryActions,
): MenuEntry[] {
  const run = entry.execution ? env.executionHref?.(entry) : null;
  const person = actor.person;
  return [
    ...(run ? [{ label: h.viewExecution, icon: "player-play", href: run }] : []),
    ...(actions?.onContact && person?.userId && entry.actor.name
      ? [
          {
            label: h.messageTo.replace("{name}", person.name),
            icon: "message",
            onClick: () => actions.onContact?.({ userId: person.userId!, name: person.name }),
          },
        ]
      : []),
  ];
}

export type ActivityRowProps = {
  row: HistoryRowModel;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  /** `me`: the person's own activity; the thing leads instead of the person, and the sentence starts with it. */
  mode: "me" | "all";
  /** A line inside an open run or batch: it leaves out what the run's line already says. */
  member?: "short";
  /** After its deed ran, so the list reads again. */
  onChanged?: () => void;
  /** Beside the day in the time, for a list without day heads. */
  dated?: boolean;
  /** A batch's members, when the row opens them in place. */
  toggle?: { open: boolean; count: number; onToggle: () => void };
  /** `chain`: a step of one vanished item's history, which names where it came from as well. */
  context?: "chain";
  /** One more quiet fact, such as the other members of its batch. */
  note?: string;
  /** The row shows its facts only; the deed belongs to what it stands under. */
  deedless?: boolean;
};

/**
 * One change in Activity: who (or, in "Me", the thing), the sentence, its quiet facts and state, the time, and at
 * most one deed. The row opens the thing where it is now, when the reader still finds it there.
 */
export function ActivityRow(props: ActivityRowProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const entry = () => props.row.lead;
  const versions = query.create({
    source: () => entry(),
    enabled: () =>
      !!props.actions?.loadVersion &&
      !props.actions.version &&
      entry().state === "done" &&
      (entry().action === "file.overwrite" || entry().action === "file.edit"),
    load: async (lead, { abortSignal }) => ({ lead, value: await props.actions!.loadVersion!(lead, abortSignal) }),
  });
  const version = () => (versions.data()?.lead === entry() ? versions.data()?.value : null);
  const actions = createMemo<HistoryActions | undefined>(() =>
    props.actions?.version
      ? props.actions
      : {
          ...props.actions,
          version: () => version() ?? null,
          onRestoreVersion: async () => {
            const restore = version()?.restore;
            if (!restore) throw new Error(h().actionFailed);
            await restore();
          },
        },
  );
  const actor = createMemo(() => actorOf(entry(), h(), props.env));
  // "Me" reads in note style, the thing first; an action without a note form keeps its full sentence.
  const linked = createMemo(
    () =>
      (props.mode === "me" || props.member
        ? noteSentence(props.row, h(), props.env, { links: true, short: props.member === "short" })
        : null) ?? sentence(props.row, h(), props.env, { context: props.context ?? "activity", links: true }),
  );
  const mark = createMemo(() => {
    const value = subjectMark(entry());
    return value ? { name: subjectName(entry())!, mark: value } : null;
  });
  const meta = createMemo(() =>
    metaParts(props.row, h(), locale(), props.env, { context: props.context ?? "activity", dated: !props.dated, actions: actions() }),
  );
  const state = () => stateOf(meta());
  const deed = createMemo(() =>
    props.deedless
      ? undefined
      : deedOf(rowAction(props.row, h(), actions() ?? {}, { links: true }), h(), props.actions?.onRestoreTrash, props.onChanged),
  );
  const more = createMemo(() => moreDeeds(entry(), actor(), h(), props.env, props.actions));
  const time = () => (props.dated ? formatWhen(entry().time, locale(), h(), props.env) : formatTime(entry().time, locale(), props.env));
  const facts = () =>
    [state()?.label, factsText(meta()), props.note, props.toggle ? h().itemsCount.replace("{count}", String(props.toggle.count)) : ""]
      .filter(Boolean)
      .join(" · ");
  return (
    <Row
      lines={[<SentenceText parts={linked()} mark={props.mode === "me" ? null : mark()} />, facts() || placeLine(linked())]}
      avatar={props.mode === "all" && !props.member ? personOf(actor()) : undefined}
      mark={props.mode === "me" && !props.member ? (mark()?.mark ?? { icon: "history" }) : undefined}
      time={time()}
      href={props.toggle ? undefined : hrefOf(linked())}
      onNavigate={props.env.onNavigate}
      onOpen={props.toggle?.onToggle}
      action={deed()}
      end={
        <Show when={more().length || props.toggle}>
          <Show when={props.toggle} fallback={<Menu label={h().activityActions} items={more()} />}>
            {(toggle) => (
              <Menu
                label={h().activityActions}
                items={[
                  {
                    label: toggle().open ? h().fewerItems : h().showItems,
                    icon: toggle().open ? "chevron-up" : "chevron-down",
                    onClick: toggle().onToggle,
                  },
                  ...more(),
                ]}
              />
            )}
          </Show>
        </Show>
      }
    />
  );
}

/** A quiet second line when a change has no facts: where it happened. */
const placeLine = (parts: readonly Part[]) =>
  parts
    .filter((part): part is Extract<Part, { kind: "place" }> => part.kind === "place")
    .map((part) => part.segments.join(" › "))
    .at(-1) ?? "";

/**
 * Many changes of one person at one time as one line that opens them in place, below it, so nothing above moves.
 * Grouping is presentation only.
 */
export function RunRow(props: {
  rows: readonly HistoryRowModel[];
  env: HistoryEnvironment;
  mode: "me" | "all";
  open: boolean;
  onToggle: () => void;
}) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const lead = () => props.rows[0]!.lead;
  const actor = createMemo(() => actorOf(lead(), h(), props.env));
  const span = () => {
    const newest = formatWhen(lead().time, locale(), h(), props.env);
    const oldest = formatTime(props.rows.at(-1)!.entries.at(-1)!.time, locale(), props.env);
    return oldest === formatTime(lead().time, locale(), props.env) ? newest : `${oldest}–${newest.split(", ").at(-1)}`;
  };
  return (
    <Row
      lines={[
        <SentenceText parts={runSentence(props.rows, h(), props.env, locale())} />,
        h().changesCount.replace("{count}", String(props.rows.length)),
      ]}
      avatar={props.mode === "all" ? personOf(actor()) : undefined}
      mark={props.mode === "me" ? { icon: "stack-2" } : undefined}
      time={span()}
      onOpen={props.onToggle}
      end={
        <Menu
          label={h().activityActions}
          items={[
            {
              label: props.open ? h().fewerItems : h().showItems,
              icon: props.open ? "chevron-up" : "chevron-down",
              onClick: props.onToggle,
            },
          ]}
        />
      }
    />
  );
}

/** A member of a batch: the thing by its name and mark, nothing more; the batch's line said who and when. */
export function MemberRow(props: { entry: ActivityEntry }) {
  const name = () => subjectName(props.entry) ?? "";
  const href = () => {
    const side = isCurrent(props.entry.after) ? props.entry.after : null;
    if (!side || side.relativePath == null) return undefined;
    return side.directory
      ? filesUrl(side.publicBaseId, side.relativePath)
      : filesUrl(side.publicBaseId, side.relativePath.split("/").slice(0, -1).join("/"), null, side.relativePath);
  };
  return <Row lines={[name()]} mark={subjectMark(props.entry) ?? { icon: "file" }} href={href()} />;
}

/** A file the person opened, in their own activity only; the recent list checked current access for this read. */
export function OpenedRow(props: { item: MarkedEntry; env: HistoryEnvironment; bases: readonly { id: string; label: string }[] }) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const folders = () => props.item.entry.path.split("/").filter(Boolean).slice(0, -1);
  const place = () => [props.bases.find((base) => base.id === props.item.base.id)?.label ?? props.item.base.name, ...folders()].join(" › ");
  const href = () =>
    props.item.entry.directory
      ? filesUrl(props.item.base.id, props.item.entry.path)
      : filesUrl(props.item.base.id, folders().join("/"), null, props.item.entry.path);
  const parts = () =>
    fill(h().memberOpened, { object: [{ kind: "name", text: props.item.entry.name }], at: [{ kind: "place", segments: [place()] }] });
  return (
    <Row
      lines={[<SentenceText parts={parts()} />, place()]}
      mark={entryMark(props.item.entry)}
      time={formatWhen(props.item.markedAt, locale(), h(), props.env)}
      href={href()}
      onNavigate={props.env.onNavigate}
    />
  );
}
