import { type DateContext, dates } from "@k2b/stdlib";
import { Button, Dropdown, type DropdownItem, MarkdownView, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { ConversationComment } from "../../service/collaboration";
import { mailReaderMessages } from "./mail-reader-messages";

/**
 * An internal note at its time in the timeline (Mail v5): a centered yellow tile with a lock and "internal", the
 * author and the time, never a message header. Its "…" edits the note in place or deletes it; a deleted note leaves
 * a quiet line where it stood.
 */
export default function MailConversationNote(props: {
  note: ConversationComment;
  dateConfig: DateContext;
  saving: boolean;
  onSave: (note: ConversationComment, body: string) => Promise<void>;
  onDelete: (note: ConversationComment) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [invalid, setInvalid] = createSignal(false);
  let form: HTMLFormElement | undefined;
  let actions: HTMLElement | undefined;

  const time = () => (
    <time dateTime={props.note.createdAt} title={dates.formatDateTime(props.note.createdAt, props.dateConfig)}>
      {dates.formatDateTimeRelative(props.note.createdAt, props.dateConfig)}
    </time>
  );
  const menu = (): DropdownItem[] => [
    ...(props.note.canEdit
      ? [
          {
            label: t().editNote,
            icon: "ti ti-pencil",
            action: () => {
              setDraft(props.note.body ?? "");
              setInvalid(false);
              setEditing(true);
              queueMicrotask(() => form?.querySelector("textarea")?.focus());
            },
          },
        ]
      : []),
    ...(props.note.canDelete
      ? [{ label: t().deleteNote, icon: "ti ti-trash", variant: "danger" as const, action: () => props.onDelete(props.note) }]
      : []),
  ];
  const close = () => {
    setEditing(false);
    queueMicrotask(() => actions?.focus());
  };
  const save = async () => {
    const body = draft().trim();
    if (!body) return void setInvalid(true);
    close();
    if (body !== (props.note.body ?? "").trim()) await props.onSave(props.note, body);
  };

  return (
    <Show
      when={!props.note.deletedAt}
      fallback={
        <p class="mail-note-deleted" data-mail-note={props.note.id} data-deleted="">
          <i class="ti ti-lock" aria-hidden="true" />
          <span>{t().noteDeletedBy({ name: props.note.author.displayName })}</span>
          <span aria-hidden="true">·</span>
          {time()}
        </p>
      }
    >
      <article class="mail-note" data-mail-note={props.note.id} aria-label={t().internalNoteBy({ name: props.note.author.displayName })}>
        <header class="mail-note-head">
          <i class={props.note.author.kind === "workflow" ? "ti ti-route" : "ti ti-note"} aria-hidden="true" />
          <span class="mail-note-author">{t().internalNoteBy({ name: props.note.author.displayName })}</span>
          <span class="mail-note-time">
            {time()}
            <Show when={props.note.editedAt}>
              <span> · {t().edited}</span>
            </Show>
          </span>
          <span class="mail-note-badge">
            <i class="ti ti-lock" aria-hidden="true" />
            {t().internal}
          </span>
          <Show when={menu().length > 0}>
            <Dropdown.Root position="bottom-left" width="12rem" items={menu()}>
              <Dropdown.Trigger iconOnly size="xs" type="button" variant="ghost" label={t().noteActions} ref={(element) => (actions = element)}>
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        </header>
        <Show
          when={editing()}
          fallback={
            <div class="mail-note-body">
              <MarkdownView markdown={props.note.body ?? ""} headingScale="compact" />
            </div>
          }
        >
          <form
            ref={form}
            class="mail-note-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          >
            <TextInput
              multiline
              lines={3}
              aria-label={t().noteText}
              value={draft}
              onValueChange={(value) => {
                setDraft(value);
                if (value.trim()) setInvalid(false);
              }}
              error={invalid() ? t().noteEmpty : undefined}
            />
            <div class="mail-note-edit-actions">
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                {t().cancel}
              </Button>
              <Button type="submit" size="sm" loading={props.saving}>
                {t().saveNote}
              </Button>
            </div>
          </form>
        </Show>
      </article>
    </Show>
  );
}
