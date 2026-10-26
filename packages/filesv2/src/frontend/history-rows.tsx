import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, InlineGuidance, prompts, Skeleton, StatusBadge, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import {
  type ActorView,
  actorOf,
  type HistoryActions,
  type HistoryEnvironment,
  type HistoryRowModel,
  isDirectory,
  type MetaPart,
  metaParts,
  type Part,
  type RestoreOutcome,
  type RowAction,
  rowAction,
  type SentenceContext,
  sentence,
  subjectName,
} from "./history-actions";
import { type HistoryMessages, useHistoryMessages } from "./history-messages";

/* ------------------------------------------------------------------ shared row parts */

export function PlacePath(props: { segments: readonly string[] }) {
  return (
    <span class="filesv2-history-path">
      <For each={props.segments}>
        {(segment, index) => (
          <>
            <Show when={index() > 0}>
              <span class="filesv2-history-path__sep"> › </span>
            </Show>
            {segment}
          </>
        )}
      </For>
    </span>
  );
}

export function Sentence(props: { parts: readonly Part[] }) {
  return (
    <For each={props.parts}>
      {(part) =>
        part.kind === "name" ? <strong>{part.text}</strong> : part.kind === "place" ? <PlacePath segments={part.segments} /> : part.text
      }
    </For>
  );
}

/** Approved avatar sizes: 30 px in lists, 26 px in the detail. The nearest public size only sets the type scale. */
const AVATAR_PX = { xs: 26, sm: 30 } as const;

/** The actor's avatar is decorative: the sentence names the actor. A finding without a Cloud entry reads as a warning. */
export function HistoryAvatar(props: { actor: ActorView; size: "xs" | "sm" }) {
  const px = () => `${AVATAR_PX[props.size]}px`;
  return (
    <span class="filesv2-history-row__who" data-actor={props.actor.kind} aria-hidden="true">
      <Avatar
        name={props.actor.kind === "person" ? props.actor.label : (props.actor.agent ?? props.actor.label)}
        icon={props.actor.icon ?? undefined}
        size={props.size}
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
              <Match when={part.kind === "text" && part}>{(item) => <span>{item().text}</span>}</Match>
            </Switch>
          </Show>
        )}
      </For>
    </p>
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
  /** List rows reveal their action on hover and focus; detail rows always show it below the sentence. */
  variant: "list" | "detail";
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
  const parts = createMemo(
    () => props.sentence ?? sentence(props.row, h(), props.env, { context: props.context, directory: props.directory }),
  );
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
    const chosen = props.action !== undefined ? props.action : rowAction(props.row, h(), actions() ?? {});
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
    <article class="filesv2-history-row" data-variant={props.variant} data-state={props.row.lead.state}>
      <HistoryAvatar actor={actor()} size={props.variant === "detail" ? "xs" : "sm"} />
      <div class="filesv2-history-row__text">
        <p class="filesv2-history-row__sentence">
          <Sentence parts={parts()} />
        </p>
        <MetaLine parts={meta()} />
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
      <div class="filesv2-history-row__action" data-keep={props.keep || runner.pending() || runner.error() ? "" : undefined}>
        <Show when={action()}>
          {(current) => (
            <Button size="sm" variant="secondary" loading={runner.pending()} onClick={() => void runner.run(current())}>
              <i class={current().icon} aria-hidden="true" />
              {current().label}
            </Button>
          )}
        </Show>
      </div>
    </article>
  );
}

/** Placeholder rows with the height of real rows, so loading never shifts the list. */
export function SkeletonRows(props: { count: number; variant: "list" | "detail" }) {
  return (
    <For each={Array.from({ length: props.count }, (_, index) => index)}>
      {() => (
        <div class="filesv2-history-row filesv2-history-row--skeleton" data-variant={props.variant} aria-hidden="true">
          <Skeleton class="filesv2-history-skeleton__who" />
          <div class="filesv2-history-row__text">
            <Skeleton class="filesv2-history-skeleton__line" />
            <Skeleton class="filesv2-history-skeleton__meta" />
          </div>
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
