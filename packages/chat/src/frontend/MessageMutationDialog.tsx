import { createApiClient } from "@k2b/cloud/browser";
import { Button, LocaleProvider, prompts, TextInput } from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import { MessageBodySchema } from "../service/contracts";
import { DialogActions, DialogError, useChatMessages } from "./chat-dialog";

type Props = {
  locale: string;
  conversationId: string;
  messageId: string;
  revision: number;
  body: string;
  operation: "edit" | "delete";
  onSaved: () => Promise<void> | undefined;
};
export const openMessageMutationDialog = (props: Props) => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<void>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <MessageMutationDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: props.operation === "edit" ? t.editMessage : t.deleteMessage,
      icon: props.operation === "edit" ? "ti ti-pencil" : "ti ti-trash",
      size: "medium",
    },
  );
};
export function MessageMutationDialog(props: Props & { close: () => void; setDismissHandler: (handler: () => void) => void }): JSX.Element {
  const t = useChatMessages();
  const [body, setBody] = createSignal(props.body);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [blocked, setBlocked] = createSignal(false);
  // Freeze an attempt after dispatch: a lost answer must retry the same payload and key.
  let attempt: { clientId: string; revision: number; body: string } | undefined;
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const save = async () => {
    if (busy() || blocked()) return;
    setBusy(true);
    setError("");
    attempt ??= { clientId: crypto.randomUUID(), revision: props.revision, body: body() };
    try {
      const route = createApiClient<ApiType>({ baseUrl: "/api/chat" }).conversations[":conversation"].messages[":message"];
      const param = { conversation: props.conversationId, message: props.messageId };
      const init = { signal: AbortSignal.timeout(30_000) };
      const response =
        props.operation === "edit"
          ? await route.$patch({ param, json: attempt }, { init })
          : await route.$delete({ param, json: { clientId: attempt.clientId, revision: attempt.revision } }, { init });
      if (!response.ok) {
        const detail = z.object({ message: z.string(), code: z.string().optional() }).safeParse(await response.json());
        if (response.status === 409 || response.status === 403 || response.status === 404) setBlocked(true);
        // Keep the same attempt even on 429: an earlier lost answer may already have committed.
        setError(response.status < 500 && detail.success ? detail.data.message : t().mutationFailed);
        return;
      }
      // The mutation is committed. Reconciliation is separate, so it cannot be submitted a second time.
      setBlocked(true);
      try {
        await props.onSaved();
        props.close();
      } catch {
        setError(t().mutationRefreshFailed);
      }
    } catch {
      setError(t().mutationFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="chat-dialog">
      <form
        id="chat-message-mutation"
        class="chat-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Show when={props.operation === "edit"} fallback={<p>{t().deleteMessageHint}</p>}>
          <TextInput
            label={t().messageBody}
            multiline
            markdown
            value={body()}
            onValueChange={setBody}
            disabled={busy() || blocked() || !!attempt}
          />
        </Show>
        <Show when={error()}>
          <DialogError message={error()} />
        </Show>
      </form>
      <DialogActions>
        <Button variant="secondary" onClick={() => props.close()} disabled={busy()}>
          {t().cancel}
        </Button>
        <Show when={!blocked()}>
          <Button
            type="submit"
            form="chat-message-mutation"
            variant={props.operation === "delete" ? "danger" : "primary"}
            loading={busy()}
            disabled={
              busy() || blocked() || (props.operation === "edit" && (body() === props.body || !MessageBodySchema.safeParse(body()).success))
            }
          >
            {error() ? t().retry : props.operation === "edit" ? t().saveMessage : t().deleteMessage}
          </Button>
        </Show>
      </DialogActions>
    </div>
  );
}
