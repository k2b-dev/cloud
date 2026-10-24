import { CloudAvatar } from "@k2b/cloud/account/ui";
import type { DateContext } from "@k2b/stdlib";
import { Button, ButtonLink, Checkbox, IconButton, MarkdownView, Placeholder, Skeleton, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, on, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { buildSpaceItemHref } from "@/routes";
import { createRetryToasts } from "../frontend/lib/feedback";
import { overviewMessages } from "../frontend/overview-messages";
import { saveCompletion } from "./completion";
import type { WorkItem } from "./MyTasks";
import { myTasksMessages } from "./messages";
import { workSchedule } from "./schedule";
import type { PwaTask } from "./task";

/** What the detail knows: the row it was opened from, then the whole task, or why it has none. */
export type TaskDetailState =
  | { kind: "loading"; item?: WorkItem }
  | { kind: "ready"; task: PwaTask }
  | { kind: "failed"; item?: WorkItem }
  | { kind: "gone" };

type Props = {
  state: TaskDetailState;
  userId: string;
  dateConfig: DateContext;
  listHref: string;
  onRetry: () => void;
  onCompletedChange: (shortId: string, done: boolean) => void;
};

type EntryState = { saving: boolean; failed: boolean };

/**
 * One task in the mobile app: done or open, when, where, who, the description and the checklist. Opened from a row,
 * it shows the row's title, Space and date at once and holds the rest's place until the task arrives. Each change
 * shows at once, keeps a spinner at its fixed place while it saves, and springs back with Retry at its row when it
 * fails. A reader without write access sees why the controls are off.
 */
export default function TaskDetail(props: Props) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const o = () => overviewMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();

  const summary = createMemo(() => {
    const state = props.state;
    if (state.kind === "ready") return state.task;
    if (state.kind === "gone" || !state.item) return null;
    return { ...state.item, event: Boolean(state.item.startsAt), completed: false } as const;
  });
  const task = () => (props.state.kind === "ready" ? props.state.task : null);

  // Changes made on this page, until the task is read again.
  const [done, setDone] = createSignal<boolean>();
  const [doneSaving, setDoneSaving] = createSignal(false);
  const [entries, setEntries] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const [entryStates, setEntryStates] = createSignal<ReadonlyMap<string, EntryState>>(new Map());
  const isDone = () => done() ?? summary()?.completed ?? false;
  const checked = (entry: PwaTask["checklist"][number]) => entries().get(entry.id) ?? entry.completed;
  const writable = () => task()?.canWrite ?? true;
  // The server renders the controls before this island runs; until then a tap would do nothing.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const ready = () => props.state.kind === "ready" && mounted();
  // A completion saved here or elsewhere reaches the task: the task's state counts again.
  createEffect(
    on(
      () => task()?.completed,
      () => setDone(undefined),
      { defer: true },
    ),
  );

  const toggleDone = async () => {
    const current = task();
    if (!current || doneSaving()) return;
    const next = !isDone();
    setDone(next);
    setDoneSaving(true);
    const outcome = await saveCompletion({ item: current, completed: next, userId: props.userId, locale: locale() });
    setDoneSaving(false);
    if (outcome === "saved") return props.onCompletedChange(current.shortId, next);
    setDone(!next);
    if (outcome === "failed")
      retryToast(
        next ? t().completeFailed({ title: current.title }) : t().reopenFailed({ title: current.title }),
        o().retry,
        () => void toggleDone(),
      );
  };

  const patchState = (id: string, next: EntryState | undefined) =>
    setEntryStates((current) => {
      const map = new Map(current);
      if (next) map.set(id, next);
      else map.delete(id);
      return map;
    });

  const toggleEntry = async (entry: PwaTask["checklist"][number], value: boolean) => {
    const current = task();
    if (!current || entryStates().get(entry.id)?.saving) return;
    setEntries((map) => new Map(map).set(entry.id, value));
    patchState(entry.id, { saving: true, failed: false });
    const response = await apiClient[":id"].items[":itemId"].checklist[":entryId"]
      .$patch({ param: { id: current.spaceShortId, itemId: current.shortId, entryId: entry.id }, json: { completed: value } })
      .catch(() => null);
    if (response?.ok) return patchState(entry.id, undefined);
    // The server kept the old state: the box springs back.
    setEntries((map) => new Map(map).set(entry.id, !value));
    if (response && (response.status === 403 || response.status === 404)) {
      patchState(entry.id, undefined);
      toast.error(response.status === 403 ? t().notAllowed({ space: current.spaceName }) : t().gone({ title: current.title }));
      return;
    }
    patchState(entry.id, { saving: false, failed: true });
  };

  const unsaved = () => [...entryStates().values()].filter((state) => state.failed).length;
  const savingEntries = () => [...entryStates().values()].some((state) => state.saving);
  const schedule = () => {
    const current = summary();
    return current ? workSchedule(current, props.dateConfig, t().allDay) : null;
  };

  const section = (title: string, aside: JSX.Element | undefined, body: JSX.Element, asideTone?: "danger") => (
    <section class="spaces-pwa-task__section">
      <h4>
        {title}
        <Show when={aside}>
          <span class="spaces-pwa-task__aside" data-tone={asideTone} aria-live="polite">
            {aside}
          </span>
        </Show>
      </h4>
      {body}
    </section>
  );

  return (
    <Show
      when={summary()}
      fallback={
        props.state.kind === "loading" ? (
          <div class="spaces-pwa-task spaces-pwa-task__loading" aria-busy="true">
            <Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--title" />
            <Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--wide" />
            <Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--short" />
          </div>
        ) : props.state.kind === "failed" ? (
          <Placeholder
            state="error"
            icon="ti ti-alert-circle"
            title={t().taskLoadFailed}
            action={
              <Button variant="secondary" onClick={() => props.onRetry()}>
                {t().retry}
              </Button>
            }
          />
        ) : (
          <Placeholder
            icon="ti ti-checkbox"
            title={t().taskGone}
            action={
              <ButtonLink variant="secondary" href={props.listHref}>
                {t().toList}
              </ButtonLink>
            }
          />
        )
      }
    >
      {(current) => (
        <div class="spaces-pwa-task">
          <div class="spaces-pwa-task__title" data-done={isDone() || undefined}>
            <Show
              when={!current().event}
              fallback={
                <span class="spaces-pwa__event" aria-hidden="true">
                  <i class="ti ti-calendar-event" />
                </span>
              }
            >
              <IconButton
                class="spaces-pwa__check"
                label={isDone() ? t().reopen : t().markDone}
                tooltip={false}
                aria-pressed={isDone()}
                disabled={!ready() || !writable()}
                onClick={() => void toggleDone()}
              >
                <i class={isDone() ? "ti ti-circle-check" : "ti ti-circle"} aria-hidden="true" />
              </IconButton>
            </Show>
            <h3>{current().title}</h3>
          </div>
          <Show when={!writable()}>
            <p class="spaces-pwa-task__note" role="status">
              <i class="ti ti-lock" aria-hidden="true" />
              {t().readOnly({ space: current().spaceName })}
            </p>
          </Show>
          <dl class="spaces-pwa-task__props">
            <dt>{current().event ? t().when : t().due}</dt>
            <dd data-overdue={schedule()?.overdue || undefined}>
              <i class={schedule()?.icon ?? "ti ti-calendar-due"} aria-hidden="true" />
              <Show when={schedule()} fallback={t().noDate}>
                {(info) => <time datetime={info().datetime}>{info().text}</time>}
              </Show>
            </dd>
            <Show when={task()?.location}>
              {(place) => (
                <>
                  <dt>{t().place}</dt>
                  <dd>
                    <i class="ti ti-map-pin" aria-hidden="true" />
                    {place()}
                  </dd>
                </>
              )}
            </Show>
            <Show when={task()?.people.length}>
              <dt>{current().event ? t().attending : t().assigned}</dt>
              <dd>
                <span class="spaces-pwa-task__avatars">
                  <For each={task()?.people}>
                    {(person) => (
                      <CloudAvatar
                        username={person.displayName}
                        userId={person.id}
                        avatarHash={person.avatarHash}
                        kind={person.kind}
                        size="xs"
                      />
                    )}
                  </For>
                </span>
                {task()
                  ?.people.map((person) => person.displayName)
                  .join(", ")}
              </dd>
            </Show>
          </dl>
          <Show
            when={task()}
            fallback={
              <Show
                when={props.state.kind === "failed"}
                fallback={
                  <div class="spaces-pwa-task__loading" aria-busy="true">
                    {section(t().description, undefined, <Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--wide" />)}
                    {section(
                      t().checklist,
                      undefined,
                      <>
                        <Skeleton class="spaces-pwa-task__sk" />
                        <Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--short" />
                        <Skeleton class="spaces-pwa-task__sk" />
                      </>,
                    )}
                  </div>
                }
              >
                <Placeholder
                  state="error"
                  icon="ti ti-alert-circle"
                  title={t().taskLoadFailed}
                  action={
                    <Button variant="secondary" onClick={() => props.onRetry()}>
                      {t().retry}
                    </Button>
                  }
                />
              </Show>
            }
          >
            {(loaded) => (
              <>
                <Show when={!loaded().description && !loaded().checklist.length}>
                  <p class="spaces-pwa-task__quiet">{loaded().event ? t().noDescription : t().nothingMore}</p>
                </Show>
                <Show when={loaded().description}>
                  {(markdown) => section(t().description, undefined, <MarkdownView markdown={markdown()} headingScale="compact" />)}
                </Show>
                <Show when={loaded().checklist.length}>
                  {section(
                    t().checklist,
                    unsaved() ? (
                      t().unsaved({ count: unsaved() })
                    ) : savingEntries() ? (
                      <>
                        <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                        {t().saving}
                      </>
                    ) : (
                      t().checked({ done: loaded().checklist.filter(checked).length, total: loaded().checklist.length })
                    ),
                    <ul class="spaces-pwa-task__checklist">
                      <For each={loaded().checklist}>
                        {(entry) => {
                          const state = () => entryStates().get(entry.id);
                          return (
                            <li data-done={checked(entry) || undefined}>
                              <Checkbox
                                label={entry.label}
                                value={() => checked(entry)}
                                disabled={!loaded().canWrite || !mounted() || state()?.saving}
                                onValueChange={(value) => void toggleEntry(entry, value)}
                              />
                              <span class="spaces-pwa-task__slot">
                                <Show when={state()?.saving}>
                                  <i class="ti ti-loader-2 k2b-spin" role="img" aria-label={t().saving} />
                                </Show>
                                <Show when={state()?.failed}>
                                  <IconButton
                                    class="spaces-pwa-task__retry"
                                    label={t().retryItem({ label: entry.label })}
                                    tooltip={false}
                                    onClick={() => void toggleEntry(entry, !checked(entry))}
                                  >
                                    <i class="ti ti-refresh" aria-hidden="true" />
                                  </IconButton>
                                </Show>
                              </span>
                            </li>
                          );
                        }}
                      </For>
                    </ul>,
                    unsaved() ? "danger" : undefined,
                  )}
                </Show>
                <div class="spaces-pwa-task__foot">
                  <ButtonLink variant="secondary" href={buildSpaceItemHref(loaded().spaceShortId, loaded().shortId)}>
                    <i class="ti ti-external-link" aria-hidden="true" />
                    {t().openInSpaces}
                  </ButtonLink>
                </div>
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
