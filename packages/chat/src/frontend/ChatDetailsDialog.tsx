import { Button, IconInput, LocaleProvider, prompts, TextInput } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { chatMessages } from "../messages";
import { type ChatDialogStore, type Conversation, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";

type DetailsProps = { store: ChatDialogStore; conversation: Conversation; locale: string };

/** Writers change the name, icon, and purpose; a system message in the chat records each change. */
export const openChatDetailsDialog = (props: DetailsProps): Promise<void | undefined> =>
  prompts.dialog<void>(
    (close) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <ChatDetailsDialog {...props} close={close} />
      </LocaleProvider>
    ),
    {
      title: chatMessages.resolve([props.locale]).t.chatDetails,
      icon: "ti ti-pencil",
      size: "medium",
    },
  );

export function ChatDetailsDialog(props: DetailsProps & { close: () => void }): JSX.Element {
  const t = useChatMessages();
  const [name, setName] = createSignal(props.conversation.name ?? "");
  const [icon, setIcon] = createSignal(props.conversation.icon ?? "");
  const [purpose, setPurpose] = createSignal(props.conversation.purpose ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  // Only changed fields go out, so an unchanged save writes no system message.
  const changes = () => {
    const next = { name: name().trim() || null, icon: icon() || null, purpose: purpose().trim() || null };
    const before = props.conversation;
    return {
      ...(next.name !== before.name ? { name: next.name } : {}),
      ...(next.icon !== before.icon ? { icon: next.icon } : {}),
      ...(next.purpose !== before.purpose ? { purpose: next.purpose } : {}),
    };
  };
  const save = async () => {
    if (busy()) return;
    const patch = changes();
    if (!Object.keys(patch).length) return props.close();
    setBusy(true);
    setError("");
    try {
      await props.store.updateDetails(props.conversation.id, patch);
      props.close();
    } catch (failure) {
      setError(errorMessage(failure, t().requestFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="chat-dialog">
      <form
        id="chat-details"
        class="chat-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput label={t().name} description={t().optionalName} maxLength={80} value={name} onValueChange={setName} disabled={busy()} />
        <IconInput label={t().icon} value={icon} onValueChange={setIcon} disabled={busy()} />
        <TextInput label={t().purpose} multiline maxLength={300} value={purpose} onValueChange={setPurpose} disabled={busy()} />
      </form>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Button variant="secondary" disabled={busy()} onClick={() => props.close()}>
          {t().cancel}
        </Button>
        <Button type="submit" form="chat-details" loading={busy()}>
          {t().save}
        </Button>
      </DialogActions>
    </div>
  );
}
