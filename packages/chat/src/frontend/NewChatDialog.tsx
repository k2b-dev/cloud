import { principalKey } from "@k2b/cloud/access/ui";
import type { DateContext } from "@k2b/stdlib";
import { Button, LocaleProvider, prompts, SegmentedControl, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ExistingMatchSchema } from "../service/contracts";
import { ChannelDialog } from "./ChannelDialogs";
import { type ChatDialogStore, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";
import { listTime } from "./chat-format";
import { createIntent } from "./create-intent";
import MemberPicker, { type ChosenMember } from "./MemberPicker";

type Match = z.infer<typeof ExistingMatchSchema>;
type NewChatProps = {
  store: ChatDialogStore;
  guest: boolean;
  viewerId: string;
  dateConfig: DateContext;
  locale: string;
  /** Resolved by Chat with current permissions before opening the form. */
  initialPerson?: ChosenMember;
};

/** Asks for the people and an optional name; resolves with the chat to open, a new one or one that already existed. */
export const openNewChatDialog = (props: NewChatProps): Promise<string | undefined> =>
  prompts.dialog<string>(
    (close, context) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <NewConversationDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: chatMessages.resolve([props.locale]).t.newChat,
      icon: "ti ti-message-plus",
      size: "medium",
    },
  );

function NewConversationDialog(
  props: NewChatProps & { setDismissHandler: (handler: () => void) => void; close: (id?: string) => void },
): JSX.Element {
  const t = useChatMessages();
  const [kind, setKind] = createSignal<"chat" | "channel">("chat");
  const [busy, setBusy] = createSignal(false);
  return (
    <div class="flex flex-col gap-4">
      <SegmentedControl
        ariaLabel={t().newChat}
        value={kind}
        disabled={busy()}
        onValueChange={setKind}
        options={[
          { value: "chat", label: t().chatChoice },
          { value: "channel", label: t().channelChoice },
        ]}
      />
      <Show when={kind() === "channel"} fallback={<NewChatDialog {...props} onBusyChange={setBusy} />}>
        <ChannelDialog {...props} onBusyChange={setBusy} />
      </Show>
    </div>
  );
}

/**
 * A chat with exactly the same direct people may exist already. Then the same dialog lists those chats, the most
 * recently active first, and opening one is the main action; a second chat with the same people stays possible.
 */
export function NewChatDialog(
  props: NewChatProps & {
    setDismissHandler: (handler: () => void) => void;
    close: (chatId?: string) => void;
    onBusyChange?: (busy: boolean) => void;
  },
): JSX.Element {
  const t = useChatMessages();
  const locale = useLocale();
  const initialChosen: ChosenMember[] =
    props.initialPerson && !(props.initialPerson.principal.type === "user" && props.initialPerson.principal.userId === props.viewerId)
      ? [props.initialPerson]
      : [];
  const [chosen, setChosen] = createSignal(initialChosen);
  const [name, setName] = createSignal("");
  const [matches, setMatches] = createSignal<readonly Match[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(() => props.onBusyChange?.(busy()));
  const [contactConflict, setContactConflict] = createSignal(false);
  const intent = createIntent(`${props.viewerId}:new`, (saved) => {
    if (props.initialPerson) {
      // Contact openings may resume only the exact request they would submit, never an unrelated tab intent.
      const input = saved.input;
      setContactConflict(
        input.members.length !== initialChosen.length ||
          input.members.some((member) => !initialChosen.some((chosen) => principalKey(member) === principalKey(chosen.principal))) ||
          !!input.name ||
          !!input.icon ||
          !!input.purpose ||
          input.allowDuplicate,
      );
      return;
    }
    setChosen(saved.chosen);
    setName(saved.input.name ?? "");
  });
  const cancel = () => {
    if (!contactConflict()) intent.clear();
    props.close();
  };
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const [error, setError] = createSignal("");
  const now = new Date();

  const create = async (allowDuplicate: boolean) => {
    if (busy() || contactConflict()) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.store.create(
        intent.begin(
          {
            members: chosen().map((member) => member.principal),
            ...(name().trim() ? { name: name().trim() } : {}),
            ...(allowDuplicate ? { allowDuplicate } : {}),
          },
          chosen(),
        ),
      );
      intent.clear();
      if (result.outcome === "created") props.close(result.conversation.id);
      else setMatches(result.matches);
    } catch (failure) {
      intent.failed(failure);
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
              disabled={busy() || !!intent.pending()}
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
              disabled={busy() || !!intent.pending()}
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
                    <Button
                      variant="ghost"
                      align="start"
                      class="chat-match"
                      disabled={busy() || !!intent.pending()}
                      onClick={() => props.close(match.id)}
                    >
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
      <Show when={contactConflict()}>
        <DialogError message={t().createContactConflict} />
      </Show>
      <Show when={intent.pending() && !busy() && !contactConflict()}>
        <p class="text-sm text-dimmed" role="status">
          {t().createRecovery}
        </p>
      </Show>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Show
          when={matches()}
          fallback={
            <>
              <Button variant="secondary" disabled={busy()} onClick={cancel}>
                {contactConflict() ? t().close : t().cancel}
              </Button>
              <Button type="submit" form="chat-new" loading={busy()} disabled={contactConflict()}>
                {intent.pending() && !contactConflict() ? t().retry : t().startChat}
              </Button>
            </>
          }
        >
          {(found) => (
            <>
              <Button
                variant="secondary"
                disabled={busy() || !!intent.pending()}
                onClick={() => {
                  if (intent.pending()) return;
                  setMatches(null);
                  setError("");
                }}
              >
                {t().back}
              </Button>
              <Show when={intent.pending()}>
                <Button variant="secondary" disabled={busy()} onClick={cancel}>
                  {t().cancel}
                </Button>
              </Show>
              <Button variant="secondary" loading={busy()} onClick={() => void create(true)}>
                {intent.pending() ? t().retry : t().createAnyway}
              </Button>
              {/* The most recently active match is the one the person most likely means. */}
              <Button disabled={busy() || !!intent.pending()} onClick={() => props.close(found()[0]?.id)}>
                {t().openExisting}
              </Button>
            </>
          )}
        </Show>
      </DialogActions>
    </div>
  );
}
