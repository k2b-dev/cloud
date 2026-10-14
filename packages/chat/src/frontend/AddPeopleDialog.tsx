import { principalKey } from "@k2b/cloud/access/ui";
import { Button, InlineGuidance, LocaleProvider, prompts, TextInput } from "@k2b/ui";
import { createEffect, createMemo, createResource, createSignal, type JSX, on, onCleanup, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import { MEMBER_PAGE_SIZE, type MemberPreviewSchema, type MemberPrincipal } from "../service/contracts";
import { type ChatDialogStore, type Conversation, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";
import MemberPicker, { type ChosenMember } from "./MemberPicker";

type Preview = z.infer<typeof MemberPreviewSchema>;
type AddPeopleProps = {
  store: ChatDialogStore;
  conversation: Conversation;
  guest: boolean;
  viewerId: string;
  locale: string;
  /** The chat has new members; a member list on screen reads them again. */
  onAdded?: () => void;
};

/** From this size a chat no longer notifies everyone by default (SCOPE 8.2). */
export const QUIET_FROM = 21;
/** From this many people through groups, a chat that people join themselves fits better. */
export const DISCOVERABLE_FROM = 21;
const PREVIEW_DELAY_MS = 250;

/** Adds people and groups; resolves with a new chat's ID when the person starts one without the history instead. */
export const openAddPeopleDialog = (props: AddPeopleProps): Promise<string | undefined> =>
  prompts.dialog<string>(
    (close) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <AddPeopleDialog {...props} close={close} />
      </LocaleProvider>
    ),
    {
      title: chatMessages.resolve([props.locale]).t.addPeople,
      icon: "ti ti-user-plus",
      size: "medium",
    },
  );

/** What an addition means for the chat: who joins and sees the history, and when the chat becomes quiet. */
export function AddPeopleSummary(props: { preview: Preview; memberCount: number }): JSX.Element {
  const t = useChatMessages();
  return (
    <div class="flex flex-col gap-2 text-sm" aria-live="polite">
      <p>{props.preview.joining > 0 ? t().joining({ count: props.preview.joining }) : t().alreadyMembers}</p>
      <Show when={props.memberCount < QUIET_FROM && props.preview.memberCount >= QUIET_FROM}>
        <p class="text-dimmed">{t().quietChat}</p>
      </Show>
      <Show when={props.preview.throughGroups >= DISCOVERABLE_FROM}>
        <p class="text-dimmed">{t().discoverableSuggestion}</p>
      </Show>
    </div>
  );
}

/**
 * Only managers open this dialog, and the server decides again. Every change of the choice asks the server who would
 * join, with groups expanded, so the counts and hints match what adding does. An unnamed chat can get a name, or
 * become a new chat without the history: that needs every current entry, so it is offered only when one page holds them.
 */
export function AddPeopleDialog(props: AddPeopleProps & { close: (chatId?: string) => void }): JSX.Element {
  const t = useChatMessages();
  const [chosen, setChosen] = createSignal<ChosenMember[]>([]);
  const [name, setName] = createSignal("");
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [previewError, setPreviewError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const unnamed = () => props.conversation.name === null;
  const principals = () => chosen().map((member) => member.principal);

  createEffect(
    on(principals, (members) => {
      setPreviewError("");
      if (!members.length) {
        setPreview(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      let current = true;
      const timer = setTimeout(async () => {
        try {
          const result = await props.store.previewMembers(props.conversation.id, members);
          if (current) setPreview(result);
        } catch (failure) {
          if (current) setPreviewError(errorMessage(failure, t().requestFailed));
        } finally {
          if (current) setChecking(false);
        }
      }, PREVIEW_DELAY_MS);
      onCleanup(() => {
        current = false;
        clearTimeout(timer);
      });
    }),
  );

  const [current] = createResource(
    () => unnamed() || undefined,
    () => props.store.members(props.conversation.id, {}),
  );
  /** The current entries without the viewer, plus the chosen ones, when they fit one new chat. */
  const freshMembers = createMemo<MemberPrincipal[] | null>(() => {
    const page = current.error ? undefined : current();
    if (!page || page.nextCursor !== null || (props.guest && page.items.some((entry) => entry.principal.type === "group"))) return null;
    const members = new Map<string, MemberPrincipal>();
    for (const entry of page.items)
      if (!entry.deactivated && (entry.principal.type !== "user" || entry.principal.userId !== props.viewerId))
        members.set(principalKey(entry.principal), entry.principal);
    for (const member of chosen()) members.set(principalKey(member.principal), member.principal);
    return members.size <= MEMBER_PAGE_SIZE ? [...members.values()] : null;
  });

  const ready = () => chosen().length > 0 && preview() !== null && !checking() && !previewError() && !busy();
  const add = async () => {
    if (!ready()) return;
    setBusy(true);
    setError("");
    try {
      await props.store.addMembers(props.conversation.id, principals());
      props.onAdded?.();
      if (unnamed() && name().trim()) await props.store.updateDetails(props.conversation.id, { name: name().trim() });
      props.close();
    } catch (failure) {
      setError(errorMessage(failure, t().requestFailed));
    } finally {
      setBusy(false);
    }
  };
  const startFresh = async () => {
    const members = freshMembers();
    if (!ready() || !members) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.store.create({
        members,
        ...(name().trim() ? { name: name().trim() } : {}),
        allowDuplicate: true,
      });
      if (result.outcome === "created") props.close(result.conversation.id);
    } catch (failure) {
      setError(errorMessage(failure, t().requestFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chat-dialog">
      <form
        id="chat-add-people"
        class="chat-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
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
        <Show when={chosen().length > 0}>
          {/* The last answer stays while the next one loads, so the text changes in place. */}
          <Show
            when={previewError()}
            fallback={
              <Show when={preview()} fallback={<InlineGuidance loading>{t().previewLoading}</InlineGuidance>}>
                {(answer) => (
                  <div aria-busy={checking()}>
                    <AddPeopleSummary preview={answer()} memberCount={props.conversation.memberCount} />
                  </div>
                )}
              </Show>
            }
          >
            <DialogError message={previewError()} />
          </Show>
        </Show>
        <Show when={unnamed()}>
          <TextInput label={t().name} description={t().unnamedChat} maxLength={80} value={name} onValueChange={setName} disabled={busy()} />
        </Show>
      </form>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Button variant="secondary" disabled={busy()} onClick={() => props.close()}>
          {t().cancel}
        </Button>
        <Show when={freshMembers()}>
          <Button variant="secondary" disabled={!ready()} onClick={() => void startFresh()}>
            {t().startWithoutHistory}
          </Button>
        </Show>
        <Button type="submit" form="chat-add-people" loading={busy()} disabled={!ready()}>
          {t().add}
        </Button>
      </DialogActions>
    </div>
  );
}
