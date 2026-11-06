import { CloudAvatar } from "@k2b/cloud/account/ui";
import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  DateTimePicker,
  Dropdown,
  IconButton,
  prompts,
  Skeleton,
  Tag,
  TextInput,
  type ToastHandle,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { SpaceItemAssignee } from "@/contracts";
import { DEADLINE_DEFAULT_TIME, deadlinePresets } from "../frontend/[id]/_components/shared/item-form/date";
import { spaceMessages } from "../frontend/[id]/messages";
import { createRetryToasts } from "../frontend/lib/feedback";
import { readResponseError } from "../frontend/lib/response";
import { myTasksMessages } from "./messages";
import PeoplePicker from "./PeoplePicker";
import { workSchedule } from "./schedule";
import type { PwaStatus } from "./space";
import type { PwaTask } from "./task";
import { moveTask, patchTask } from "./task-writes";

type Field = "status" | "due" | "people";
type FieldState = { saving?: boolean; failed?: boolean };

/** What the rows show before the task arrives: what the row it was opened from knew. */
export type TaskPreview = { statusId?: string; statuses?: PwaStatus[]; deadline: string | null; people?: SpaceItemAssignee[] };

type Props = {
  /** The task as read; undefined while it loads, when `preview` fills what it can. */
  task?: PwaTask;
  preview?: TaskPreview;
  userId: string;
  /** The person, for "Assign to me". */
  me?: SpaceItemAssignee;
  dateConfig: DateContext;
  /** The pickers open only once the island runs, the task is here, the reader may change it and the device is online. */
  editable: boolean;
  /** The rows around the task in its status, for Undo after a move. */
  nextShortId?: string;
  previousShortId?: string;
  /** Reads the task again after a change; resolves once the read covers it. */
  onRefresh: () => Promise<void>;
  /** Something changed that lists show, so they read again. */
  onChanged: () => void;
};

/**
 * The task's properties as rows that each open their own picker: Status (the way to move without dragging), Due,
 * Assigned, and the tags. A choice shows at once and keeps a spinner in the row's fixed slot at its end while it
 * saves; a failure puts the old value back, offers ↻ in the same slot, and says what stays in a notice. Nothing moves
 * while it does. A done status completes the task, with the claim decision of checking it off, and stays closed while
 * unfinished tasks block it.
 */
export function TaskProps(props: Props) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const [states, setStates] = createSignal<Partial<Record<Field, FieldState>>>({});
  const [shownStatus, setShownStatus] = createSignal<string>();
  const [shownDue, setShownDue] = createSignal<string | null>();
  const [shownPeople, setShownPeople] = createSignal<SpaceItemAssignee[]>();
  const [peopleOpen, setPeopleOpen] = createSignal(false);
  const [peopleNote, setPeopleNote] = createSignal<string>();
  let undo: ToastHandle | undefined;
  let ownPeopleWrites = 0;
  onCleanup(() => undo?.dismiss());

  const statuses = () => props.task?.statuses ?? props.preview?.statuses ?? [];
  const statusId = () => shownStatus() ?? props.task?.statusId ?? props.preview?.statusId;
  const status = () => statuses().find((entry) => entry.id === statusId());
  // The preview fills in only until the task is here; a loaded task without a date has none.
  const due = () => (shownDue() !== undefined ? shownDue()! : props.task ? props.task.deadline : (props.preview?.deadline ?? null));
  const people = () => shownPeople() ?? props.task?.people ?? props.preview?.people;
  const patchState = (field: Field, next: FieldState | undefined) => setStates((current) => ({ ...current, [field]: next }));

  // A fresh read retires what the rows showed meanwhile; a change made elsewhere while the people are open says so.
  createEffect(
    on(
      () => props.task,
      (task, previous) => {
        if (!states().status?.saving) setShownStatus(undefined);
        if (!states().due?.saving) setShownDue(undefined);
        if (!states().people?.saving) {
          const before = previous?.people.map((person) => person.id).join();
          if (peopleOpen() && ownPeopleWrites === 0 && before !== undefined && before !== task?.people.map((person) => person.id).join())
            setPeopleNote(t().peopleChanged);
          setShownPeople(undefined);
        }
        // A change made elsewhere after a move makes its Undo stale.
        if (undo && task && task.statusId !== undoTarget) {
          undo.dismiss();
          undo = undefined;
        }
      },
      { defer: true },
    ),
  );
  let undoTarget: string | undefined;

  const target = () => props.task!;
  /** Reads the task again after a saved change; false when that read failed, so the row keeps the saved value. */
  const refreshed = async () => {
    const read = await props.onRefresh().then(
      () => true,
      () => false,
    );
    props.onChanged();
    return read;
  };
  /** The last attempt of each row, which its ↻ repeats. */
  let lastStatus: PwaStatus | undefined;
  let lastDue: string | null = null;

  const move = async (next: PwaStatus, options: { undo?: { before?: string; after?: string } } = {}) => {
    const task = target();
    const from = status();
    // Undo puts the task back between the rows around it when it left.
    const neighbors = { before: props.nextShortId, after: props.previousShortId };
    // One move at a time: a later choice waits until the earlier one settled, so the server ends at the latest.
    if (!from || next.id === from.id || states().status?.saving) return;
    lastStatus = next;
    setShownStatus(next.id);
    patchState("status", { saving: true });
    const outcome = await moveTask({
      task,
      statusId: next.id,
      beforeItemId: options.undo?.before,
      afterItemId: options.undo?.after,
      userId: props.userId,
      locale: locale(),
    });
    if (outcome === "saved") {
      const read = await refreshed();
      patchState("status", undefined);
      if (read) setShownStatus(undefined);
      if (!options.undo) {
        undoTarget = next.id;
        undo?.dismiss();
        undo = toast.success(t().movedTo({ title: task.title, status: next.name }), {
          action: {
            label: t().undo,
            onClick: () => {
              undo?.dismiss();
              undo = undefined;
              setShownStatus(undefined);
              void move(from, { undo: neighbors });
            },
          },
        });
      }
      return;
    }
    setShownStatus(undefined);
    patchState("status", outcome === "failed" ? { failed: true } : undefined);
    if (outcome === "failed") retryToast(t().statusFailed({ title: task.title, status: from.name }), t().retry, () => void move(next));
  };

  const setDue = async (value: string | null) => {
    const task = target();
    if (states().due?.saving) return;
    lastDue = value;
    setShownDue(value);
    patchState("due", { saving: true });
    const response = await patchTask(task, { deadline: value });
    if (response?.ok) {
      const read = await refreshed();
      patchState("due", undefined);
      if (read) setShownDue(undefined);
      return;
    }
    setShownDue(undefined);
    if (response && response.status < 500) {
      patchState("due", undefined);
      toast.error(await readResponseError(response, t().dueFailed({ title: task.title })));
      return;
    }
    patchState("due", { failed: true });
    retryToast(t().dueFailed({ title: task.title }), t().retry, () => void setDue(value));
  };

  /** Adds or removes one person; the server applies it beside what others change meanwhile. */
  let lastPeople: [SpaceItemAssignee, boolean] | undefined;
  /** People changes go one after another, so the server ends at the person's latest choice for each. */
  let peopleQueue = Promise.resolve();
  const togglePerson = (person: SpaceItemAssignee, chosen: boolean) => {
    const before = people() ?? [];
    setShownPeople(
      chosen ? [...before.filter((entry) => entry.id !== person.id), person] : before.filter((entry) => entry.id !== person.id),
    );
    peopleQueue = peopleQueue.then(() => savePerson(person, chosen));
    return peopleQueue;
  };
  /** The claim a removal needs: the person's own goes along; someone else's asks once whether to take it over. */
  const claimFor = async (person: SpaceItemAssignee) => {
    const claim = props.task?.claim;
    if (!claim || claim.actor.id !== person.id) return {};
    if (claim.actor.id === props.userId) return { claimId: claim.id };
    const s = spaceMessages.resolve([locale()]).t;
    const confirmed = await prompts.confirm(s.takeOverHelp({ name: claim.displayName }), {
      title: s.takeOverTitle,
      icon: "ti ti-replace",
      confirmText: s.takeOverClaim,
      cancelText: s.cancel,
    });
    return confirmed ? { claimId: claim.id, force: true as const } : null;
  };
  const savePerson = async (person: SpaceItemAssignee, chosen: boolean) => {
    const task = target();
    lastPeople = [person, chosen];
    const claim = chosen ? {} : await claimFor(person);
    if (claim === null) return void setShownPeople(undefined);
    setPeopleNote(undefined);
    patchState("people", { saving: true });
    ownPeopleWrites += 1;
    const response = await patchTask(task, chosen ? { addAssigneeIds: [person.id] } : { removeAssigneeIds: [person.id], ...claim });
    if (response?.ok) {
      const read = await refreshed();
      ownPeopleWrites -= 1;
      patchState("people", undefined);
      // The read covers this change and any made meanwhile, so the rows show the server's list.
      if (read) setShownPeople(undefined);
      return;
    }
    ownPeopleWrites -= 1;
    setShownPeople(undefined);
    if (response && response.status < 500) {
      patchState("people", undefined);
      toast.error(await readResponseError(response, t().assigneesFailed({ title: task.title })));
      return;
    }
    patchState("people", { failed: true });
    retryToast(t().assigneesFailed({ title: task.title }), t().retry, () => void togglePerson(person, chosen));
  };

  const retry: Record<Field, () => void> = {
    status: () => lastStatus && void move(lastStatus),
    due: () => void setDue(lastDue),
    people: () => lastPeople && void togglePerson(...lastPeople),
  };

  const statusValue = () => (
    <Show when={status()} fallback={<Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--value" />}>
      {(current) => (
        <span class="spaces-pwa-task__inline">
          <span class="spaces-pwa__dot" style={{ "background-color": current().color }} aria-hidden="true" />
          {current().name}
        </span>
      )}
    </Show>
  );
  const dueValue = (value: string | null) => {
    const info = value
      ? workSchedule({ startsAt: null, endsAt: null, deadline: value, deadlineAllDay: !value.includes("T") }, props.dateConfig, t().allDay)
      : null;
    return (
      <span class="spaces-pwa-task__inline" data-overdue={(info?.overdue && !props.task?.completed) || undefined}>
        <i class="ti ti-calendar-due spaces-pwa-task__muted" aria-hidden="true" />
        <Show when={info} fallback={t().noDue}>
          {(shown) => <time datetime={shown().datetime}>{shown().text}</time>}
        </Show>
      </span>
    );
  };
  const peopleValue = () => (
    <Show when={people()} fallback={<Skeleton class="spaces-pwa-task__sk spaces-pwa-task__sk--value" />}>
      {(list) => (
        <span class="spaces-pwa-task__inline">
          <Show when={list().length} fallback={<span class="spaces-pwa-task__muted">{t().nobody}</span>}>
            <span class="spaces-pwa-task__avatars" aria-hidden="true">
              <For each={list().slice(0, 3)}>
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
            <span class="spaces-pwa-task__names">
              {list()
                .map((person) => person.displayName.split(" ")[0])
                .join(", ")}
            </span>
          </Show>
        </span>
      )}
    </Show>
  );

  /** One row: its label, its value or picker, and the fixed slot at the end for ⌄, the spinner or ↻. */
  const row = (field: Field, label: string, value: JSX.Element) => (
    <>
      <dt>{label}</dt>
      <dd class="spaces-pwa-task__prop" data-failed={states()[field]?.failed || undefined}>
        <span class="spaces-pwa-task__prop-value">{value}</span>
        <span class="spaces-pwa-task__slot" aria-live="polite">
          <Show when={props.editable && !states()[field]?.saving && !states()[field]?.failed}>
            <i class="ti ti-chevron-down spaces-pwa-task__muted" aria-hidden="true" />
          </Show>
          <Show when={states()[field]?.saving}>
            <i class="ti ti-loader-2 k2b-spin" role="img" aria-label={t().saving} />
          </Show>
          <Show when={states()[field]?.failed}>
            <IconButton class="spaces-pwa-task__retry" label={t().retryField({ label })} tooltip={false} onClick={() => retry[field]()}>
              <i class="ti ti-refresh" aria-hidden="true" />
            </IconButton>
          </Show>
        </span>
      </dd>
    </>
  );

  return (
    <>
      {row(
        "status",
        t().status,
        <Show when={props.editable && props.task} fallback={statusValue()}>
          <Dropdown
            phone="sheet"
            variant="touch"
            position="bottom-left"
            label={t().status}
            items={[
              {
                sectionLabel: t().status,
                items: statuses().map((entry) => ({
                  label: entry.name,
                  color: entry.color,
                  choice: "radio" as const,
                  checked: () => entry.id === statusId(),
                  description: entry.done ? (props.task?.blocked ? t().blockersFirst : t().completesTask) : undefined,
                  disabled: entry.done && props.task?.blocked && entry.id !== statusId(),
                  action: () => void move(entry),
                })),
              },
            ]}
          >
            <Dropdown.Trigger appearance="plain" class="spaces-pwa-task__picker" disabled={states().status?.saving}>
              {statusValue()}
            </Dropdown.Trigger>
          </Dropdown>
        </Show>,
      )}
      {row(
        "due",
        t().due,
        <Show when={props.editable && props.task} fallback={dueValue(due())}>
          <span class="spaces-pwa-task__picker spaces-pwa-task__picker--date">
            <DateTimePicker
              aria-label={t().due}
              appearance="plain"
              placeholder={t().noDue}
              value={due}
              onValueChange={(value) => void setDue(value)}
              disabled={states().due?.saving}
              renderValue={(value) => dueValue(value)}
              presets={deadlinePresets(props.dateConfig)}
              optionalTime
              defaultTime={DEADLINE_DEFAULT_TIME}
              dateConfig={props.dateConfig}
              clearable
            />
          </span>
        </Show>,
      )}
      {row(
        "people",
        t().assignee,
        <Show when={props.editable && props.task} fallback={peopleValue()}>
          {(task) => (
            <PeoplePicker
              spaceShortId={task().spaceShortId}
              userId={props.userId}
              me={props.me}
              selected={people() ?? []}
              onToggle={(person, chosen) => void togglePerson(person, chosen)}
              note={peopleNote() ?? t().peopleNote}
              label={t().assignee}
              class="spaces-pwa-task__picker"
              onOpenChange={(open) => {
                setPeopleOpen(open);
                if (!open) setPeopleNote(undefined);
              }}
            >
              {peopleValue()}
            </PeoplePicker>
          )}
        </Show>,
      )}
      <Show when={props.task?.tags.length}>
        <dt>{t().tags}</dt>
        <dd>
          <For each={props.task?.tags}>
            {(tag) => (
              <Tag size="sm" color={tag.color}>
                {tag.name}
              </Tag>
            )}
          </For>
        </dd>
      </Show>
    </>
  );
}

/**
 * The title as a field: Enter or Save stores it with the title it started from, so a change made meanwhile is never
 * overwritten unseen. Two lines below the field always keep their place: the keys, or, once the title changed
 * elsewhere, the new title with "Use the new title". The typed text stays either way.
 */
export function TitleEditor(props: { task: PwaTask; onDone: () => void; onRefresh: () => Promise<void>; onChanged: () => void }) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const [text, setText] = createSignal(props.task.title);
  /** The title the edit started from; a mismatch on the server means someone changed it meanwhile. */
  const [base, setBase] = createSignal(props.task.title);
  const [saving, setSaving] = createSignal(false);
  const changed = () => (props.task.title !== base() ? props.task.title : undefined);

  const submit = () => {
    // Saving after a change elsewhere replaces that title knowingly.
    if (changed()) setBase(props.task.title);
    void save();
  };
  const save = async () => {
    const title = text().trim();
    if (!title || saving()) return;
    if (title === props.task.title) return props.onDone();
    setSaving(true);
    const response = await patchTask(props.task, { title, expectedTitle: base() });
    setSaving(false);
    if (response?.ok) {
      await props.onRefresh().catch(() => undefined);
      props.onChanged();
      props.onDone();
      return;
    }
    if (response?.status === 409) {
      // The title changed elsewhere: the next read shows it under the field; saving again replaces it knowingly.
      await props.onRefresh().catch(() => undefined);
      return;
    }
    toast.error(response && response.status < 500 ? await readResponseError(response, t().titleFailed) : t().titleFailed);
  };

  return (
    <div class="spaces-pwa-task__title-edit" ref={(element) => queueMicrotask(() => element.querySelector("textarea")?.focus())}>
      <TextInput
        aria-label={t().titleLabel}
        value={text}
        onValueChange={setText}
        multiline
        lines={2}
        maxLength={200}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") props.onDone();
        }}
      />
      <div class="spaces-pwa-task__title-hint" role="status" data-tone={changed() ? "warning" : undefined}>
        <Show
          when={changed()}
          fallback={
            <>
              <p>{t().titleEnterSaves}</p>
              <p>{t().titleCancelKeeps}</p>
            </>
          }
        >
          {(title) => (
            <>
              <p>
                <i class="ti ti-alert-triangle" aria-hidden="true" />
                <span class="spaces-pwa-task__title-hint-text">{t().titleChanged({ title: title() })}</span>
              </p>
              <p>
                {t().titleReplaces}
                <button
                  type="button"
                  class="spaces-pwa-task__link"
                  onClick={() => {
                    setText(title());
                    setBase(title());
                  }}
                >
                  {t().takeNewTitle}
                </button>
              </p>
            </>
          )}
        </Show>
      </div>
      <div class="spaces-pwa-task__title-actions">
        <Button variant="ghost" size="sm" onClick={() => props.onDone()}>
          {t().cancel}
        </Button>
        <Button variant="primary" size="sm" loading={saving()} onClick={submit}>
          {t().save}
        </Button>
      </div>
    </div>
  );
}
