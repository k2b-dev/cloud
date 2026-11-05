import { CloudAvatar } from "@k2b/cloud/account/ui";
import type { DateContext } from "@k2b/stdlib";
import { DateTimePicker, Dropdown, IconButton, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ItemTemplateDraft, SpaceItemAssignee, SpaceItemTemplate } from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
import { DEADLINE_DEFAULT_TIME, deadlinePresets } from "../frontend/[id]/_components/shared/item-form/date";
import { type Outgoing, readTemplateDraft } from "./create";
import { myTasksMessages } from "./messages";
import PeoplePicker from "./PeoplePicker";
import { firstOpenStatus, OutgoingRow, type QuickAddTarget } from "./QuickAdd";
import type { PwaSpaceEntry } from "./space";

const draftKey = (space: string) => `spaces-pwa:draft:${space}`;
const readDraft = (space: string) => {
  try {
    return localStorage.getItem(draftKey(space)) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (space: string, text: string) => {
  try {
    if (text) localStorage.setItem(draftKey(space), text);
    else localStorage.removeItem(draftKey(space));
  } catch {
    // A draft that cannot be kept on the device stays in the field while it is open.
  }
};

type ComposerProps = {
  userId: string;
  me: SpaceItemAssignee;
  /** The Space the task goes to; undefined while "My tasks" reads the Space just chosen. */
  target?: QuickAddTarget;
  /** In "My tasks": the Spaces a task may go to, with a chip to switch; the task is assigned to the person. */
  spaces?: PwaSpaceEntry[];
  onSpaceChange?: (shortId: string) => void;
  template?: SpaceItemTemplate;
  online: boolean;
  dateConfig: DateContext;
  /** Outgoing tasks of "My tasks", shown above the field; a Space shows them in their status. */
  outbox?: Outgoing[];
  onResend?: (key: string) => void;
  onSubmit: (task: { spaceShortId: string; body: Outgoing["body"] }) => void;
  onClose: () => void;
};

/**
 * The quick add above the keyboard: × to close, the title, and Add; below it what the task gets: its Space in "My
 * tasks", its status (the first open one), when it is due, and who does it. Enter adds the task and keeps the field
 * open for the next; × closes it, and the text stays on the device as a draft. Offline, Add is off and says why.
 */
export default function Composer(props: ComposerProps) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const space = () => props.target?.shortId ?? "mine";
  const draftSpace = () => (props.spaces ? "mine" : space());
  const [title, setTitle] = createSignal(readDraft(draftSpace()));
  const [statusId, setStatusId] = createSignal<string>();
  const [deadline, setDeadline] = createSignal<string | null>(null);
  const [people, setPeople] = createSignal<SpaceItemAssignee[]>(props.spaces ? [props.me] : []);
  const [draft, setDraft] = createSignal<ItemTemplateDraft | null>(null);
  let field: HTMLTextAreaElement | undefined;

  // A new Space starts at its first open status; the person's own choice holds while the Space stays.
  createEffect(
    on(
      () => props.target,
      (target) => {
        setStatusId(target ? firstOpenStatus(target.statuses)?.id : undefined);
      },
    ),
  );
  // A template fills what it proposes, as the form on the web does; the title stays the person's.
  createEffect(
    on(
      () => [props.template?.id, props.target?.shortId] as const,
      async ([templateId, spaceShortId]) => {
        setDraft(null);
        if (!templateId || !spaceShortId) return;
        const read = await readTemplateDraft(spaceShortId, templateId, props.dateConfig.timeZone ?? "UTC");
        if (props.template?.id !== templateId) return;
        setDraft(read);
        if (read?.item.deadline) setDeadline(read.item.deadline);
      },
    ),
  );
  createEffect(on(title, (text) => writeDraft(draftSpace(), text), { defer: true }));

  const status = () => props.target?.statuses.find((entry) => entry.id === statusId());
  const ready = () => Boolean(title().trim() && props.target && statusId() && props.online);

  const grow = () => {
    if (!field) return;
    field.style.height = "auto";
    // Up to three lines, then the field scrolls.
    const line = Number.parseFloat(getComputedStyle(field).lineHeight) || 24;
    const padding = field.offsetHeight - field.clientHeight + Number.parseFloat(getComputedStyle(field).paddingTop) * 2;
    field.style.height = `${Math.min(field.scrollHeight, line * 3 + padding)}px`;
  };
  onMount(() => {
    field = document.querySelector<HTMLTextAreaElement>(".spaces-pwa-composer__field textarea") ?? undefined;
    field?.focus();
    grow();
  });

  const submit = () => {
    const target = props.target;
    const column = statusId();
    const text = title().trim();
    if (!target || !column || !text || !props.online) return;
    const filled = draft()?.item;
    props.onSubmit({
      spaceShortId: target.shortId,
      body: {
        title: text,
        columnId: column,
        requestKey: crypto.randomUUID(),
        ...(deadline() ? { deadline: deadline()! } : {}),
        ...(people().length || filled?.assigneeIds.length
          ? { assigneeIds: [...new Set([...people().map((person) => person.id), ...(filled?.assigneeIds ?? [])])] }
          : {}),
        ...(filled?.description ? { description: filled.description } : {}),
        ...(filled?.priority ? { priority: filled.priority } : {}),
        ...(filled?.tagIds.length ? { tagIds: filled.tagIds } : {}),
        ...(filled?.checklist.length ? { checklist: filled.checklist } : {}),
        ...(filled?.estimatedDurationMinutes ? { estimatedDurationMinutes: filled.estimatedDurationMinutes } : {}),
        ...(filled?.assignCreator ? { assignCreator: true } : {}),
      },
    });
    setTitle("");
    queueMicrotask(grow);
    field?.focus();
  };

  const close = () => {
    writeDraft(draftSpace(), title());
    props.onClose();
  };
  onCleanup(() => writeDraft(draftSpace(), title()));

  const toggle = (person: SpaceItemAssignee, chosen: boolean) =>
    setPeople((current) =>
      chosen ? [...current.filter((entry) => entry.id !== person.id), person] : current.filter((entry) => entry.id !== person.id),
    );
  const peopleLabel = () => {
    const chosen = people();
    if (!chosen.length) return t().assignee;
    if (chosen.length === 1 && chosen[0]!.id === props.userId) return t().me;
    return chosen.map((person) => (person.id === props.userId ? t().me : person.displayName.split(" ")[0])).join(", ");
  };
  const template = () => props.template;

  return (
    <div class="spaces-pwa-composer" data-k2b-shell-bottom role="group" aria-label={t().newTask}>
      <Show when={props.outbox?.length}>
        <ul class="spaces-pwa__list spaces-pwa-composer__outbox">
          <For each={props.outbox}>{(entry) => <OutgoingRow entry={entry} onResend={props.onResend} />}</For>
        </ul>
      </Show>
      <Show when={!props.online}>
        <p class="spaces-pwa__offline" role="status">
          <i class="ti ti-wifi-off" aria-hidden="true" />
          {t().offlineCreate}
        </p>
      </Show>
      <Show when={template()}>
        {(chosen) => (
          <p class="spaces-pwa-composer__from">
            <i class={chosen().icon ?? "ti ti-template"} aria-hidden="true" />
            {t().fromTemplate({ name: chosen().name })}
          </p>
        )}
      </Show>
      <div class="spaces-pwa-composer__row">
        <IconButton class="spaces-pwa-composer__close" label={t().closeKeepsDraft} tooltip={false} onClick={close}>
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
        <TextInput
          class="spaces-pwa-composer__field"
          aria-label={t().taskTitle}
          placeholder={template() ? t().templatePlaceholder({ name: template()!.name }) : t().whatToDo}
          value={title}
          onValueChange={(value) => {
            setTitle(value);
            grow();
          }}
          multiline
          lines={1}
          maxLength={200}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape") close();
          }}
        />
        <IconButton
          class="spaces-pwa-composer__send"
          variant="primary"
          label={t().addTask}
          tooltip={false}
          disabled={!ready()}
          onClick={submit}
        >
          <i class="ti ti-arrow-up" aria-hidden="true" />
        </IconButton>
      </div>
      <div class="spaces-pwa-composer__chips">
        <Show when={props.spaces}>
          {(spaces) => (
            <Dropdown
              phone="sheet"
              variant="touch"
              label={t().spaceChip}
              items={spaces().map((entry) => ({
                label: entry.name,
                color: entry.color,
                choice: "radio" as const,
                checked: () => entry.shortId === props.target?.shortId,
                action: () => props.onSpaceChange?.(entry.shortId),
              }))}
            >
              <Dropdown.Trigger variant="secondary" size="sm" class="spaces-pwa-composer__chip" data-set="">
                <span
                  class="spaces-pwa__dot"
                  style={{ "background-color": props.target?.color ?? "var(--k2b-text-muted)" }}
                  aria-hidden="true"
                />
                {props.target?.name ?? spaces().find((entry) => entry.shortId === space())?.name ?? t().spaceChip}
                <i class="ti ti-chevron-down" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown>
          )}
        </Show>
        <Dropdown
          phone="sheet"
          variant="touch"
          label={t().status}
          disabled={!props.target}
          items={(props.target?.statuses ?? [])
            .filter((entry) => !entry.done)
            .map((entry) => ({
              label: entry.name,
              color: entry.color,
              choice: "radio" as const,
              checked: () => entry.id === statusId(),
              action: () => setStatusId(entry.id),
            }))}
        >
          <Dropdown.Trigger variant="secondary" size="sm" class="spaces-pwa-composer__chip" disabled={!props.target}>
            <span class="spaces-pwa__dot" style={{ "background-color": status()?.color ?? "var(--k2b-text-muted)" }} aria-hidden="true" />
            {status()?.name ?? t().status}
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown>
        <span class="spaces-pwa-composer__chip spaces-pwa-composer__date" data-set={deadline() ? "" : undefined}>
          <DateTimePicker
            aria-label={t().due}
            appearance="plain"
            placeholder={t().due}
            value={deadline}
            onValueChange={setDeadline}
            renderValue={(value) => (
              <span class="spaces-pwa-composer__chip-value">
                <i class="ti ti-calendar-due" aria-hidden="true" />
                {formatDeadline(value, props.dateConfig)}
              </span>
            )}
            presets={deadlinePresets(props.dateConfig)}
            optionalTime
            defaultTime={DEADLINE_DEFAULT_TIME}
            dateConfig={props.dateConfig}
            clearable
          />
        </span>
        <Show when={props.target}>
          {(target) => (
            <PeoplePicker
              spaceShortId={target().shortId}
              userId={props.userId}
              selected={people()}
              onToggle={toggle}
              label={t().assignee}
              appearance="chip"
              class="spaces-pwa-composer__chip"
            >
              <Show when={people().length} fallback={<i class="ti ti-user-plus" aria-hidden="true" />}>
                <span class="spaces-pwa-space__people" aria-hidden="true">
                  <For each={people().slice(0, 3)}>
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
              </Show>
              {peopleLabel()}
            </PeoplePicker>
          )}
        </Show>
        <Show when={draft()?.item.checklist.length}>
          {(count) => (
            <span class="spaces-pwa-composer__note">
              <i class="ti ti-list-check" aria-hidden="true" />
              {t().checklistCount({ count: count() })}
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}
