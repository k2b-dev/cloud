import type { DateContext } from "@k2b/stdlib";
import { Button, LocaleProvider, prompts, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ExistingMatchSchema } from "../service/contracts";
import { type ChatDialogStore, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";
import { listTime } from "./chat-format";
import MemberPicker, { type ChosenMember } from "./MemberPicker";

type Match = z.infer<typeof ExistingMatchSchema>;
type NewChatProps = { store: ChatDialogStore; guest: boolean; viewerId: string; dateConfig: DateContext; locale: string };

/** Asks for the people and an optional name; resolves with the chat to open, a new one or one that already existed. */
export const openNewChatDialog = (props: NewChatProps): Promise<string | undefined> =>
  prompts.dialog<string>(
    (close, context) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <NewChatDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: chatMessages.resolve([props.locale]).t.newChat,
      icon: "ti ti-message-plus",
      size: "medium",
    },
  );

/**
 * A chat with exactly the same direct people may exist already. Then the same dialog lists those chats, the most
 * recently active first, and opening one is the main action; a second chat with the same people stays possible.
 */
export function NewChatDialog(
  props: NewChatProps & { setDismissHandler: (handler: () => void) => void; close: (chatId?: string) => void },
): JSX.Element {
  const t = useChatMessages();
  const locale = useLocale();
  const [chosen, setChosen] = createSignal<ChosenMember[]>([]);
  const [name, setName] = createSignal("");
  const [matches, setMatches] = createSignal<readonly Match[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const [error, setError] = createSignal("");
  const now = new Date();

  const create = async (allowDuplicate: boolean) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.store.create({
        members: chosen().map((member) => member.principal),
        ...(name().trim() ? { name: name().trim() } : {}),
        ...(allowDuplicate ? { allowDuplicate } : {}),
      });
      if (result.outcome === "created") props.close(result.conversation.id);
      else setMatches(result.matches);
    } catch (failure) {
      setError(errorMessage(failure, t().requestFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chat-dialog">
      <Show
        when={matches()}
        fallback={
          <form
            id="chat-new"
            class="chat-dialog__body"
            onSubmit={(event) => {
              event.preventDefault();
              void create(false);
            }}
          >
            <MemberPicker
              guest={props.guest}
              chosen={chosen()}
              excluded={[{ type: "user", userId: props.viewerId }]}
              people={props.store.people}
              disabled={busy()}
              onChange={setChosen}
            />
            <Show when={chosen().length === 0}>
              <p class="text-sm text-dimmed">{t().selfChatHint}</p>
            </Show>
            <TextInput
              label={t().name}
              description={t().optionalName}
              maxLength={80}
              value={name}
              onValueChange={setName}
              disabled={busy()}
            />
          </form>
        }
      >
        {(found) => (
          <div class="chat-dialog__body">
            <p class="text-sm">{found().length === 1 ? t().existingChat : t().existingChats}</p>
            <ul class="flex flex-col" aria-label={t().existingChatsLabel}>
              <For each={found()}>
                {(match) => (
                  <li>
                    <Button variant="ghost" align="start" class="chat-match" disabled={busy()} onClick={() => props.close(match.id)}>
                      <span class="min-w-0 flex-1 truncate">{match.title}</span>
                      <Show when={match.archived}>
                        <StatusBadge tone="neutral" variant="text" icon="ti ti-archive" label={t().archived} />
                      </Show>
                      <time class="chat-match__time" datetime={match.lastActivityAt}>
                        {listTime(match.lastActivityAt, now, { ...props.dateConfig, locale: locale() })}
                      </time>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Show
          when={matches()}
          fallback={
            <>
              <Button variant="secondary" disabled={busy()} onClick={() => props.close()}>
                {t().cancel}
              </Button>
              <Button type="submit" form="chat-new" loading={busy()}>
                {t().startChat}
              </Button>
            </>
          }
        >
          {(found) => (
            <>
              <Button
                variant="secondary"
                disabled={busy()}
                onClick={() => {
                  setMatches(null);
                  setError("");
                }}
              >
                {t().back}
              </Button>
              <Button variant="secondary" loading={busy()} onClick={() => void create(true)}>
                {t().createAnyway}
              </Button>
              {/* The most recently active match is the one the person most likely means. */}
              <Button disabled={busy()} onClick={() => props.close(found()[0]?.id)}>
                {t().openExisting}
              </Button>
            </>
          )}
        </Show>
      </DialogActions>
    </div>
  );
}
