import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { Tag } from "../surfaces/Tag";
import { ColorInput } from "./ChoiceInputs";
import { TextInput } from "./TextInput";

export type TagEditorItem = {
  id: string;
  name: string;
  color?: string | null;
};

export type TagEditorValue = {
  name: string;
  color: string;
};

export type TagEditorLabels = {
  create: string;
  empty: string;
  name: string;
  namePlaceholder: string;
  color: string;
  save: string;
  cancel: string;
  edit: string;
  remove: string;
};

export type TagEditorProps<T extends TagEditorItem = TagEditorItem> = {
  items: readonly T[];
  onCreate?: (value: TagEditorValue) => void | Promise<void>;
  onUpdate?: (item: T, value: TagEditorValue) => void | Promise<void>;
  onDelete?: (item: T) => void | Promise<void>;
  labels?: Partial<TagEditorLabels>;
  defaultColor?: string;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
};

type EditorFormProps = {
  initial?: TagEditorItem;
  labels: TagEditorLabels;
  defaultColor: string;
  busy: boolean;
  saveError: string;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (value: TagEditorValue) => Promise<void>;
};

function EditorForm(props: EditorFormProps): JSX.Element {
  const initialName = props.initial?.name ?? "";
  const initialColor = props.initial?.color ?? props.defaultColor;
  const [name, setName] = createSignal(initialName);
  const [color, setColor] = createSignal(initialColor);
  const [error, setError] = createSignal<string>();

  createEffect(() => props.onDirtyChange?.(name() !== initialName || color() !== initialColor));
  onCleanup(() => props.onDirtyChange?.(false));

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const normalized = name().trim();
    if (!normalized || props.busy) return;
    setError(undefined);
    try {
      await props.onSave({ name: normalized, color: color() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : props.saveError);
    }
  };

  return (
    <form class="k2b-tag-editor__form" aria-busy={props.busy ? "true" : undefined} onSubmit={submit}>
      <div class="k2b-tag-editor__fields">
        <TextInput
          label={props.labels.name}
          placeholder={props.labels.namePlaceholder}
          value={name}
          onValueChange={setName}
          disabled={props.busy}
          required
          autofocus
        />
        <ColorInput
          aria-label={props.labels.color}
          value={color}
          onValueChange={setColor}
          onValueCommit={setColor}
          disabled={props.busy}
          compact
        />
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="k2b-tag-editor__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="k2b-tag-editor__form-actions">
        <Button type="submit" size="sm" loading={props.busy} disabled={!name().trim()}>
          {props.labels.save}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {props.labels.cancel}
        </Button>
      </div>
    </form>
  );
}

/** Controlled tag manager. Persistence, authorization, confirmation, and toasts stay with the consumer. */
export function TagEditor<T extends TagEditorItem = TagEditorItem>(props: TagEditorProps<T>): JSX.Element {
  const messages = useUiMessages();
  const [mode, setMode] = createSignal<"create" | string | null>(null);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [rowError, setRowError] = createSignal<{ id: string; message: string }>();
  const labels = (): TagEditorLabels => ({
    create: messages().addTag,
    empty: messages().noTagsYet,
    name: messages().name,
    namePlaceholder: messages().tagName,
    color: messages().color,
    save: messages().save,
    cancel: messages().cancel,
    edit: messages().edit,
    remove: messages().delete,
    ...props.labels,
  });
  const defaultColor = () => props.defaultColor ?? "#6b7280";
  const run = async (id: string, action: () => void | Promise<void>) => {
    if (busyId()) return;
    setBusyId(id);
    setRowError(undefined);
    try {
      await action();
      setMode(null);
    } catch (cause) {
      setRowError({ id, message: cause instanceof Error ? cause.message : messages().tagActionFailed });
      throw cause;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class={`k2b-tag-editor ${props.class ?? ""}`} data-disabled={props.disabled ? "true" : undefined}>
      <Show when={props.items.length > 0} fallback={<p class="k2b-tag-editor__empty">{labels().empty}</p>}>
        <ul class="k2b-tag-editor__list">
          <For each={props.items}>
            {(item) => (
              <li class="k2b-tag-editor__row">
                <Show
                  when={mode() === item.id && props.onUpdate}
                  fallback={
                    <>
                      <Tag color={item.color}>{item.name}</Tag>
                      <span class="k2b-tag-editor__row-actions">
                        <Show when={props.onUpdate}>
                          <IconButton
                            size="xs"
                            variant="ghost"
                            label={`${labels().edit} ${item.name}`}
                            disabled={props.disabled || Boolean(busyId())}
                            onClick={() => setMode(item.id)}
                          >
                            <i class="ti ti-pencil" aria-hidden="true" />
                          </IconButton>
                        </Show>
                        <Show when={props.onDelete}>
                          {(remove) => (
                            <IconButton
                              size="xs"
                              variant="ghost"
                              label={`${labels().remove} ${item.name}`}
                              loading={busyId() === item.id}
                              disabled={props.disabled || Boolean(busyId())}
                              onClick={() => void run(item.id, () => remove()(item)).catch(() => undefined)}
                            >
                              <i class="ti ti-trash" aria-hidden="true" />
                            </IconButton>
                          )}
                        </Show>
                      </span>
                    </>
                  }
                >
                  <EditorForm
                    initial={item}
                    labels={labels()}
                    defaultColor={defaultColor()}
                    busy={busyId() === item.id}
                    saveError={messages().tagCouldNotBeSaved}
                    onCancel={() => setMode(null)}
                    onDirtyChange={props.onDirtyChange}
                    onSave={(value) => run(item.id, () => props.onUpdate?.(item, value))}
                  />
                </Show>
                <Show when={rowError()?.id === item.id && mode() !== item.id ? rowError() : undefined}>
                  {(error) => (
                    <p class="k2b-tag-editor__error" role="alert">
                      {error().message}
                    </p>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.onCreate}>
        {(create) => (
          <Show
            when={mode() === "create"}
            fallback={
              <Button size="xs" variant="subtle" disabled={props.disabled || Boolean(busyId())} onClick={() => setMode("create")}>
                <i class="ti ti-plus" aria-hidden="true" />
                {labels().create}
              </Button>
            }
          >
            <EditorForm
              labels={labels()}
              defaultColor={defaultColor()}
              busy={busyId() === "create"}
              saveError={messages().tagCouldNotBeSaved}
              onCancel={() => setMode(null)}
              onDirtyChange={props.onDirtyChange}
              onSave={(value) => run("create", () => create()(value))}
            />
          </Show>
        )}
      </Show>
    </div>
  );
}

export default TagEditor;
