import { Button, LocaleProvider, prompts, TextInput } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { chatMessages } from "../messages";
import { DialogActions, DialogError, useChatMessages } from "./chat-dialog";
import { ChatRequestError } from "./chat-store";
import type { Thread, ThreadList } from "./threads";

export type ThreadDialogStore = {
  createThread(chatId: string, input: { name: string; description: string | null; createKey: string }): Promise<Thread>;
  updateThread(chatId: string, threadId: string, patch: { name?: string; description?: string | null }): Promise<Thread>;
};
type ThreadDialogProps = {
  store: ThreadDialogStore;
  chatId: string;
  title: string;
  memberCount: number;
  /** The chat's threads, archived ones included, to report a taken name at once. */
  threads: ThreadList | null;
  /** Renames this thread; without it the dialog creates one. */
  thread?: Thread;
  locale: string;
};

/**
 * Admins create a thread with a name and an optional one-line description, or rename one. A taken name shows at once;
 * a failed request keeps the text and turns the main button into "Try again". Resolves with the saved thread.
 */
export const openThreadDialog = (props: ThreadDialogProps): Promise<Thread | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<Thread>(
    (close, context) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <ThreadDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: props.thread ? t.renameThread : t.newThreadTitle({ title: props.title }),
      icon: props.thread ? "ti ti-pencil" : "ti ti-hash",
      size: "medium",
    },
  );
};

export function ThreadDialog(
  props: ThreadDialogProps & { close: (thread?: Thread) => void; setDismissHandler: (handler: () => void) => void },
): JSX.Element {
  const t = useChatMessages();
  const [name, setName] = createSignal(props.thread?.name ?? "");
  const [description, setDescription] = createSignal(props.thread?.description ?? "");
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [taken, setTaken] = createSignal<string | null>(null);
  // One key per dialog: a retry after a lost answer finds the thread it already created.
  const createKey = crypto.randomUUID();
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const duplicate = () => {
    const wanted = name().trim().toLowerCase();
    if (!wanted) return false;
    if (taken() === wanted) return true;
    return (props.threads?.items ?? []).some((thread) => thread.id !== props.thread?.id && thread.name.toLowerCase() === wanted);
  };
  const save = async () => {
    const trimmed = name().trim();
    if (busy() || !trimmed || duplicate()) return;
    setBusy(true);
    setFailed(false);
    try {
      const nextDescription = description().trim() || null;
      const thread = props.thread
        ? await props.store.updateThread(props.chatId, props.thread.id, {
            ...(trimmed !== props.thread.name ? { name: trimmed } : {}),
            ...(nextDescription !== props.thread.description ? { description: nextDescription } : {}),
          })
        : await props.store.createThread(props.chatId, { name: trimmed, description: nextDescription, createKey });
      props.close(thread);
    } catch (failure) {
      if (failure instanceof ChatRequestError && failure.code === "THREAD_NAME_TAKEN") setTaken(trimmed.toLowerCase());
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const unchanged = () =>
    props.thread !== undefined &&
    name().trim() === props.thread.name &&
    (description().trim() || null) === (props.thread.description ?? null);
  return (
    <div class="chat-dialog">
      <p class="chat-dialog__intro">{props.thread ? t().renameIntro : t().newThreadIntro({ count: props.memberCount })}</p>
      <form
        id="chat-thread"
        class="chat-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput
          label={t().threadName}
          placeholder={t().threadNamePlaceholder}
          maxLength={80}
          value={name}
          onValueChange={(value) => {
            setName(value);
            setFailed(false);
          }}
          disabled={busy()}
          autofocus
          error={duplicate() ? t().threadNameTaken({ name: name().trim(), title: props.title }) : undefined}
        />
        <TextInput
          label={t().threadDescription}
          description={t().threadDescriptionHint}
          placeholder={t().threadDescriptionPlaceholder}
          maxLength={80}
          value={description}
          onValueChange={(value) => {
            setDescription(value);
            setFailed(false);
          }}
          disabled={busy()}
        />
      </form>
      <Show when={failed()}>
        <DialogError message={props.thread ? t().renameThreadFailed : t().createThreadFailed} />
      </Show>
      <DialogActions>
        <Button variant="secondary" disabled={busy()} onClick={() => props.close()}>
          {t().cancel}
        </Button>
        <Button
          type="submit"
          form="chat-thread"
          loading={busy()}
          disabled={!name().trim() || duplicate() || unchanged()}
        >
          {failed() ? t().retry : props.thread ? t().rename : t().create}
        </Button>
      </DialogActions>
    </div>
  );
}
