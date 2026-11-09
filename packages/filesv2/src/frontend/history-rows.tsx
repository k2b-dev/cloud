import { Link } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, InlineGuidance, prompts, Skeleton, StatusBadge, Tag, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import type { MarkedEntry } from "../contracts";
import {
  type ActorView,
  actorOf,
  actorParts,
  fill,
  formatTime,
  formatWhen,
  type HistoryActions,
  type HistoryEnvironment,
  type HistoryRowModel,
  isDirectory,
  type MetaPart,
  metaParts,
  noteSentence,
  type Part,
  plain,
  type RestoreOutcome,
  type RowAction,
  rowAction,
  runDestination,
  runSentence,
  type SentenceContext,
  sentence,
  subjectName,
  viaLabel,
} from "./history-actions";
import { type HistoryMessages, useHistoryMessages } from "./history-messages";
import { filesUrl } from "./urls";

/* ------------------------------------------------------------------ shared row parts */

type Navigate = HistoryEnvironment["onNavigate"];

/** A breadcrumb inside a sentence; segments with an address open that folder. */
export function PlacePath(props: { segments: readonly string[]; hrefs?: readonly (string | null)[]; onNavigate?: Navigate }) {
  return (
    <span class="filesv2-history-path">
      <For each={props.segments}>
        {(segment, index) => (
          <>
            <Show when={index() > 0}>
              <span class="filesv2-history-path__sep"> › </span>
            </Show>
            <Show when={props.hrefs?.[index()]} fallback={segment}>
              {(href) => (
                <Link class="filesv2-history-target" href={href()} onNavigate={props.onNavigate}>
                  {segment}
                </Link>
              )}
            </Show>
          </>
        )}
      </For>
    </span>
  );
}

/** Names are strong; a current item is a link, a vanished one says so quietly. Compact rows set actors in regular weight. */
export function Sentence(props: { parts: readonly Part[]; compact?: boolean; onNavigate?: Navigate }) {
  return (
    <For each={props.parts}>
      {(part) => (
        <Switch fallback={part.kind === "text" ? part.text : null}>
          <Match when={part.kind === "actor" && part}>
            {(actor) => (props.compact ? <span class="filesv2-history-actor">{actor().text}</span> : <strong>{actor().text}</strong>)}
          </Match>
          <Match when={part.kind === "name" && part}>
            {(item) => (
              <>
                <Show when={item().href} fallback={<strong>{item().text}</strong>}>
                  {(href) => (
                    <Link class="filesv2-history-target filesv2-history-target--name" href={href()} onNavigate={props.onNavigate}>
                      {item().text}
                    </Link>
                  )}
                </Show>
                <Show when={item().hint}>{(hint) => <span class="filesv2-history-hint"> ({hint()})</span>}</Show>
              </>
            )}
          </Match>
          <Match when={part.kind === "place" && part}>
            {(place) => <PlacePath segments={place().segments} hrefs={place().hrefs} onNavigate={props.onNavigate} />}
          </Match>
        </Switch>
      )}
    </For>
  );
}

/** Approved avatar sizes: 30 px in lists, 26 px in the detail, 20 px in compact rows. The public size sets the type scale. */
const AVATAR_PX = { compact: 20, xs: 26, sm: 30 } as const;

/** The actor's avatar is decorative: the sentence names the actor. A finding without a Cloud entry reads as a warning. */
export function HistoryAvatar(props: { actor: ActorView; size: "compact" | "xs" | "sm" }) {
  const px = () => `${AVATAR_PX[props.size]}px`;
  return (
    <span class="filesv2-history-row__who" data-actor={props.actor.kind} aria-hidden="true">
      <Avatar
        name={props.actor.kind === "person" ? props.actor.label : (props.actor.agent ?? props.actor.label)}
        icon={props.actor.icon ?? undefined}
        size={props.size === "compact" ? "xs" : props.size}
        style={{
          width: px(),
          height: px(),
          ...(props.actor.kind === "observed" ? { background: "var(--k2b-warning-surface)", color: "var(--k2b-warning-text)" } : {}),
        }}
      />
    </span>
  );
}

function MetaDot() {
  return (
    <span class="filesv2-history-row__dot" aria-hidden="true">
      {"\u2060·\u2060"}
    </span>
  );
}

/**
 * Quiet facts joined by dots. The line flows as text: a dot touches its neighbours without a break opportunity, so a
 * wrap happens inside a fact and never leaves a dot at the start or end of a line.
 */
export function MetaLine(props: { parts: readonly MetaPart[] }) {
  const followingTime = (index: number) => {
    const next = props.parts[index + 1];
    return next?.kind === "time" ? next : undefined;
  };
  return (
    <p class="filesv2-history-row__meta">
      <For each={props.parts}>
        {(part, index) => (
          <Show when={!(part.kind === "time" && props.parts[index() - 1]?.kind === "status")}>
            <Show when={index() > 0}>
              <MetaDot />
            </Show>
            <Switch>
              <Match when={part.kind === "status" && part}>
                {(status) => (
                  // A badge is a box; group it with its time so WebKit cannot strand their separator.
                  <span class="filesv2-history-row__lead">
                    <StatusBadge
                      class="filesv2-history-row__status"
                      tone={status().tone === "running" ? "running" : status().tone}
                      icon={status().icon}
                      label={status().label}
                    />
                    <Show when={followingTime(index())}>
                      {(time) => (
                        <>
                          <MetaDot />
                          <time datetime={time().iso}>{time().text}</time>
                        </>
                      )}
                    </Show>
                  </span>
                )}
              </Match>
              <Match when={part.kind === "time" && part}>{(time) => <time datetime={time().iso}>{time().text}</time>}</Match>
              <Match when={part.kind === "link" && part}>
                {(link) => (
                  <a class="filesv2-history-link" href={link().href}>
                    {link().label}
                  </a>
                )}
              </Match>
              <Match when={(part.kind === "text" || part.kind === "via") && part}>{(item) => <span>{item().text}</span>}</Match>
            </Switch>
          </Show>
        )}
      </For>
    </p>
  );
}

/**
 * The facts of a compact row, at its end: state and quiet facts, then the channel as a small tag, then the time, so
 * times line up down the list.
 */
export function CompactFacts(props: { parts: readonly MetaPart[] }) {
  const facts = () => props.parts.filter((part) => part.kind !== "via" && part.kind !== "time");
  const via = () => props.parts.find((part): part is Extract<MetaPart, { kind: "via" }> => part.kind === "via");
  const time = () => props.parts.find((part): part is Extract<MetaPart, { kind: "time" }> => part.kind === "time");
  return (
    <span class="filesv2-history-row__facts">
      <Show when={facts().length > 0}>
        <span class="filesv2-history-row__facts-text">
          <For each={facts()}>
            {(part, index) => (
              <>
                <Show when={index() > 0}>
                  <MetaDot />
                </Show>
                <Switch>
                  <Match when={part.kind === "status" && part}>
                    {(status) => (
                      <StatusBadge
                        class="filesv2-history-row__status"
                        tone={status().tone === "running" ? "running" : status().tone}
                        icon={status().icon}
                        label={status().label}
                      />
                    )}
                  </Match>
                  <Match when={part.kind === "link" && part}>
                    {(link) => (
                      <a class="filesv2-history-link" href={link().href}>
                        {link().label}
                      </a>
                    )}
                  </Match>
                  <Match when={part.kind === "text" && part}>{(item) => <span>{item().text}</span>}</Match>
                </Switch>
              </>
            )}
          </For>
        </span>
      </Show>
      <Show when={via()}>
        {(channel) => (
          <Tag size="sm" class="filesv2-history-via">
            {channel().text}
          </Tag>
        )}
      </Show>
      <Show when={time()}>
        {(at) => (
          <time class="filesv2-history-row__time" datetime={at().iso}>
            {at().text}
          </time>
        )}
      </Show>
    </span>
  );
}

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

/** Runs one row action, keeps the row's button busy, and leaves a visible error beside the row on failure. */
export function useRowAction(onChanged?: () => void) {
  const h = useHistoryMessages();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (action: RowAction) => {
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      await action.run();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : h().actionFailed);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

export type HistoryRowProps = {
  row: HistoryRowModel;
  env: HistoryEnvironment;
  actions?: HistoryActions;
  context: SentenceContext;
  /** Rows under a day heading show the time alone. */
  dated: boolean;
  /**
   * List rows reveal their action on hover and focus; detail rows always show it below the sentence. Compact rows
   * keep one line with the facts at the end, the way the activity list reads.
   */
  variant: "list" | "detail" | "compact";
  /** Names and folders of current sides become links, and vanished items say so; only for the viewer's own reader. */
  links?: boolean;
  /** The previous line names the same actor, so this compact row leaves its avatar and name out. */
  repeat?: boolean;
  /**
   * Compact rows only. `all` shows the actor in its own column before the change; `me` is the reader's own activity
   * and shows no actor at all.
   */
  mode?: "me" | "all";
  /** `short`: a line inside a run whose line names the destination, so a rename shows only its names. */
  member?: "short";
  directory?: boolean;
  /** Replaces the sentence or meta for rows that describe a state instead of a change. */
  sentence?: readonly Part[];
  meta?: readonly MetaPart[];
  action?: RowAction | null;
  /** Shows a list row's action without hover, for a row whose action is the reason it is shown. */
  keep?: boolean;
  others?: number;
  onChanged?: () => void;
};

/** One activity row: who, one sentence, quiet facts, at most one action, and the visible members of a batch. */
export function HistoryRow(props: HistoryRowProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const versions = query.create({
    source: () => props.row.lead,
    enabled: () =>
      !!props.actions?.loadVersion &&
      !props.actions.version &&
      props.row.lead.state === "done" &&
      (props.row.lead.action === "file.overwrite" || props.row.lead.action === "file.edit"),
    load: async (entry, { abortSignal }) => ({ entry, value: await props.actions!.loadVersion!(entry, abortSignal) }),
  });
  const version = () => (versions.data()?.entry === props.row.lead ? versions.data()?.value : null);
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
  const actor = createMemo(() => actorOf(props.row.lead, h(), props.env));
  const compact = () => props.variant === "compact";
  // Compact rows read in note style, the item first; an action without a note form keeps its full sentence.
  const note = createMemo(() =>
    compact() && !props.sentence ? noteSentence(props.row, h(), props.env, { links: props.links, short: props.member === "short" }) : null,
  );
  const parts = createMemo(
    () =>
      props.sentence ??
      note() ??
      sentence(props.row, h(), props.env, {
        context: props.context,
        directory: props.directory,
        links: props.links,
      }),
  );
  const showsActor = () => compact() && props.mode !== "me";
  const meta = createMemo(
    () =>
      props.meta ??
      metaParts(props.row, h(), locale(), props.env, {
        context: props.context,
        dated: props.dated,
        actions: actions(),
        others: props.others,
      }),
  );
  const action = createMemo(() => {
    const chosen = props.action !== undefined ? props.action : rowAction(props.row, h(), actions() ?? {}, { links: props.links });
    const trashed = chosen?.restoresTrash;
    const restore = props.actions?.onRestoreTrash;
    return trashed && restore ? { ...chosen, run: () => restoreFromTrash(trashed, restore, h()) } : chosen;
  });
  const runner = useRowAction(() => props.onChanged?.());
  const [expanded, setExpanded] = createSignal(false);
  const membersId = `filesv2-history-members-${createUniqueId()}`;
  const members = () => (props.row.kind === "batch" ? props.row.entries : []);
  const shown = () => (expanded() ? members() : members().slice(0, 3));
  return (
    <article
      class="filesv2-history-row"
      data-variant={props.variant}
      data-mode={compact() ? (props.mode ?? "all") : undefined}
      data-state={props.row.lead.state}
    >
      <Show when={!compact() || showsActor()}>
        <Show when={!(compact() && props.repeat)} fallback={<span class="filesv2-history-row__who" data-repeat="" aria-hidden="true" />}>
          <HistoryAvatar actor={actor()} size={compact() ? "compact" : props.variant === "detail" ? "xs" : "sm"} />
        </Show>
      </Show>
      <Show when={showsActor()}>
        {/* A full sentence names its actor itself; a repeated actor stays in place for screen readers only. */}
        <span class="filesv2-history-row__actor" data-repeat={props.repeat ? "" : undefined}>
          {note() ? plain(actorParts(actor(), h())) : ""}
        </span>
      </Show>
      <div class="filesv2-history-row__text">
        <p class="filesv2-history-row__sentence">
          <Sentence parts={parts()} compact={compact()} onNavigate={props.env.onNavigate} />
        </p>
        <Show when={!compact()}>
          <MetaLine parts={meta()} />
        </Show>
        <Show when={members().length > 0}>
          <ul id={membersId} class="filesv2-history-row__members">
            <For each={shown()}>
              {(member: ActivityEntry) => (
                <li>
                  <i class={isDirectory(member) ? "ti ti-folder" : "ti ti-file"} aria-hidden="true" />
                  <span class="filesv2-history-row__member-name">{subjectName(member)}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={members().length > 3}>
            <Button
              size="xs"
              variant="text"
              class="filesv2-history-row__more"
              aria-expanded={expanded()}
              aria-controls={membersId}
              onClick={() => setExpanded(!expanded())}
            >
              <i class={expanded() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
              {expanded() ? h().fewerItems : h().moreItems.replace("{count}", String(members().length - 3))}
            </Button>
          </Show>
        </Show>
        <Show when={versions.loading()}>
          <span class="sr-only" role="status">
            {h().loading}
          </span>
        </Show>
        <Show when={versions.error()}>
          <p class="filesv2-history-row__error" role="alert">
            {versions.error() instanceof Error ? versions.error()!.message : h().historyFailed}
            <Button size="xs" variant="text" class="filesv2-history-link" onClick={() => void versions.refresh()}>
              {h().retry}
            </Button>
          </p>
        </Show>
        <Show when={runner.error()}>
          {(message) => (
            <p class="filesv2-history-row__error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <Show when={compact()}>
        <CompactFacts parts={meta()} />
      </Show>
      <div class="filesv2-history-row__action" data-keep={props.keep || runner.pending() || runner.error() ? "" : undefined}>
        <Show when={action()}>
          {(current) => (
            <Button
              size={compact() ? "xs" : "sm"}
              variant="secondary"
              loading={runner.pending()}
              onClick={() => void runner.run(current())}
            >
              <i class={current().icon} aria-hidden="true" />
              {current().label}
            </Button>
          )}
        </Show>
      </div>
    </article>
  );
}

export type HistoryRunRowProps = {
  rows: readonly HistoryRowModel[];
  env: HistoryEnvironment;
  actions?: HistoryActions;
  links?: boolean;
  repeat?: boolean;
  mode?: "me" | "all";
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  onChanged?: () => void;
};

/**
 * Many changes of one person at one time as one line that opens them. The toggle keeps its place and size; its
 * rows follow below it, so opening moves nothing above. Grouping is presentation only.
 */
export function HistoryRunRow(props: HistoryRunRowProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const rowsId = `filesv2-history-run-${createUniqueId()}`;
  const lead = () => props.rows[0]!.lead;
  const actor = createMemo(() => actorOf(lead(), h(), props.env));
  const facts = createMemo<MetaPart[]>(() => {
    const newest = formatTime(lead().time, locale(), props.env);
    const oldestTime = props.rows.at(-1)!.entries.at(-1)!.time;
    const oldest = formatTime(oldestTime, locale(), props.env);
    const via = viaLabel(lead(), h(), props.env);
    return [
      ...(via ? [{ kind: "via" as const, text: via }] : []),
      { kind: "time", iso: lead().time, text: oldest === newest ? newest : `${oldest}–${newest}` },
    ];
  });
  const showsActor = () => props.mode !== "me";
  // Lines under a line that names the destination show only what changed besides it.
  const short = () => (runDestination(props.rows, props.env) ? ("short" as const) : undefined);
  return (
    <div class="filesv2-history-run" data-expanded={props.expanded ? "" : undefined}>
      <button
        type="button"
        class="filesv2-history-row filesv2-history-run__toggle"
        data-variant="compact"
        data-mode={props.mode ?? "all"}
        aria-expanded={props.expanded}
        aria-controls={rowsId}
        onClick={() => props.onToggle(!props.expanded)}
      >
        <Show when={showsActor()}>
          <Show when={!props.repeat} fallback={<span class="filesv2-history-row__who" data-repeat="" aria-hidden="true" />}>
            <HistoryAvatar actor={actor()} size="compact" />
          </Show>
          <span class="filesv2-history-row__actor" data-repeat={props.repeat ? "" : undefined}>
            {plain(actorParts(actor(), h()))}
          </span>
        </Show>
        <span class="filesv2-history-row__text">
          <span class="filesv2-history-row__sentence">
            {/* Inside a button nothing else is interactive, so the destination is named without links. */}
            <Sentence parts={runSentence(props.rows, h(), props.env, locale())} compact />
          </span>
        </span>
        <span class="filesv2-history-row__facts">
          <Show when={facts().find((part) => part.kind === "via")}>
            {(via) => (
              <Tag size="sm" class="filesv2-history-via">
                {via().text}
              </Tag>
            )}
          </Show>
          <span class="filesv2-history-run__count">
            {props.rows.length}
            <i class="ti ti-chevron-down filesv2-history-run__chevron" aria-hidden="true" />
          </span>
          <time class="filesv2-history-row__time" datetime={lead().time}>
            {facts().find((part) => part.kind === "time")?.text}
          </time>
        </span>
      </button>
      <ul id={rowsId} class="filesv2-history-run__rows" hidden={!props.expanded}>
        <For each={props.rows}>
          {(row) => (
            <li>
              <HistoryRow
                row={row}
                env={props.env}
                actions={props.actions}
                context="activity"
                dated
                variant="compact"
                mode={props.mode}
                links={props.links}
                repeat
                member={short()}
                onChanged={props.onChanged}
              />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/**
 * A file the person opened, in their own activity only. The recent list resolves each pointer against current access
 * on every read, so its name and folders lead there directly.
 */
export function OpenedRow(props: {
  item: MarkedEntry;
  env: HistoryEnvironment;
  bases: readonly { id: string; label: string }[];
  /** `relative` for a list without day headings: "yesterday" or a date instead of the time. */
  when?: "time" | "relative";
}) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const parts = createMemo<Part[]>(() => {
    const { base, entry } = props.item;
    const folders = entry.path.split("/").filter(Boolean).slice(0, -1);
    const href = entry.directory ? filesUrl(base.id, entry.path) : filesUrl(base.id, folders.join("/"), null, entry.path);
    const label = props.bases.find((candidate) => candidate.id === base.id)?.label ?? base.name;
    const segments = [label, ...folders];
    return fill(h().memberOpened, {
      object: [{ kind: "name", text: entry.name, href }],
      at: [{ kind: "place", segments, hrefs: segments.map((_, index) => filesUrl(base.id, folders.slice(0, index).join("/"))) }],
    });
  });
  // Under a day heading the time alone; in a list without headings the same "today, 14:32" as the change rows.
  const time = () =>
    props.when === "relative"
      ? formatWhen(props.item.markedAt, locale(), h(), props.env)
      : formatTime(props.item.markedAt, locale(), props.env);
  return (
    <article class="filesv2-history-row filesv2-history-row--opened" data-variant="compact" data-mode="me" data-state="done">
      <div class="filesv2-history-row__text">
        <p class="filesv2-history-row__sentence">
          <Sentence parts={parts()} compact onNavigate={props.env.onNavigate} />
        </p>
      </div>
      <CompactFacts parts={[{ kind: "time", iso: props.item.markedAt, text: time() }]} />
    </article>
  );
}

/** Placeholder rows with the height of real rows, so loading never shifts the list. */
export function SkeletonRows(props: { count: number; variant: "list" | "detail" | "compact" }) {
  return (
    <For each={Array.from({ length: props.count }, (_, index) => index)}>
      {() => (
        <div class="filesv2-history-row filesv2-history-row--skeleton" data-variant={props.variant} aria-hidden="true">
          <Skeleton class="filesv2-history-skeleton__who" />
          <div class="filesv2-history-row__text">
            <Skeleton class="filesv2-history-skeleton__line" />
            <Show when={props.variant !== "compact"}>
              <Skeleton class="filesv2-history-skeleton__meta" />
            </Show>
          </div>
          <Show when={props.variant === "compact"}>
            <Skeleton class="filesv2-history-skeleton__facts" />
          </Show>
        </div>
      )}
    </For>
  );
}

/** End of a loaded list: older pages, a failed page with retry, or the search limit. */
export function MoreFooter(props: { hasMore: boolean; loadingMore: boolean; failed: boolean; limitReached: boolean; onMore: () => void }) {
  const h = useHistoryMessages();
  return (
    <div class="filesv2-history-more">
      <Show when={props.failed}>
        <InlineGuidance tone="danger" role="alert">
          {h().olderFailed}
        </InlineGuidance>
      </Show>
      <Show when={props.hasMore || props.failed}>
        <Button size="sm" variant="text" loading={props.loadingMore} loadingLabel={h().loadingOlder} onClick={props.onMore}>
          <i class={props.failed ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
          {props.failed ? h().retry : h().loadOlder}
        </Button>
      </Show>
      <Show when={props.limitReached}>
        <InlineGuidance tone="info">{h().searchLimit}</InlineGuidance>
      </Show>
    </div>
  );
}
