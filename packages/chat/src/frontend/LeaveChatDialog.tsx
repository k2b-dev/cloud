import { Button, Combobox, InlineGuidance, LocaleProvider, prompts, toast } from "@k2b/ui";
import { createResource, createSignal, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { MemberSchema } from "../service/contracts";
import { type ChatDialogStore, type Conversation, DialogActions, DialogError, errorMessage, useChatMessages } from "./chat-dialog";
import { ChatRequestError } from "./chat-store";
import { MemberAvatar } from "./MemberPicker";

type LeaveProps = { store: ChatDialogStore; conversation: Conversation; viewerId: string; locale: string };
type Member = z.infer<typeof MemberSchema>;

/** Resolves true once the viewer has left; their open view then ends in "No access" through the live revoke. */
export const openLeaveChatDialog = (props: LeaveProps): Promise<boolean | undefined> =>
  prompts.dialog<boolean>(
    (close, context) => (
      // A prompt renders outside the workspace, so its content gets the workspace's locale again.
      <LocaleProvider locale={props.locale}>
        <LeaveChatDialog {...props} close={close} setDismissHandler={context.setDismissHandler} />
      </LocaleProvider>
    ),
    {
      title: chatMessages.resolve([props.locale]).t.leaveChatTitle,
      icon: "ti ti-logout",
      size: "medium",
    },
  );

/**
 * Leaving ends access to the history, unless a group keeps the person in the chat. The last manager hands the chat
 * over first: the member list's manager count says when. A refusal reads the list again, so the dialog follows a
 * change someone else made in the meantime.
 */
export function LeaveChatDialog(
  props: LeaveProps & { setDismissHandler: (handler: () => void) => void; close: (left?: boolean) => void },
): JSX.Element {
  const t = useChatMessages();
  const [successor, setSuccessor] = createSignal<Member | null>(null);
  // The rows of the last search, so a choice keeps the person's avatar.
  let offered = new Map<string, Member>();
  const [busy, setBusy] = createSignal(false);
  props.setDismissHandler(() => {
    if (!busy()) props.close();
  });
  const [error, setError] = createSignal("");
  const manager = () => props.conversation.permission === "admin";
  // Only a manager can be the last one, so only a manager asks.
  const [page, { refetch }] = createResource(
    () => manager() || undefined,
    () => props.store.members(props.conversation.id, {}),
  );
  // A failed read throws when read, so the error state is checked first.
  const loaded = () => (page.error ? undefined : page());
  const needsSuccessor = () => loaded()?.managers === 1;
  // Nobody else holds a direct entry, so there is nobody to hand the chat to and leaving is refused.
  const alone = () => {
    const current = loaded();
    return (
      current?.nextCursor === null &&
      !current.items.some((member) => member.principal.type === "user" && member.principal.userId !== props.viewerId)
    );
  };
  const checking = () => manager() && page.loading;
  const blocked = () => checking() || Boolean(page.error) || alone() || (needsSuccessor() && !successor());

  const leave = async () => {
    if (busy() || blocked()) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.store.leave(props.conversation.id, needsSuccessor() ? successor()?.accessId : undefined);
      if (result.keptThroughGroup) toast(t().leftKeptThroughGroup);
      props.close(true);
    } catch (failure) {
      setError(errorMessage(failure, t().requestFailed));
      if (failure instanceof ChatRequestError && failure.status === 409 && manager()) void refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chat-dialog">
      <div class="chat-dialog__body">
        <p class="text-sm">{t().leaveChatDescription}</p>
        <Show when={checking()}>
          <InlineGuidance loading>{t().membersLoading}</InlineGuidance>
        </Show>
        <Show when={page.error}>
          <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
            {t().membersFailed}{" "}
            <Button variant="text" size="xs" onClick={() => void refetch()}>
              {t().retry}
            </Button>
          </InlineGuidance>
        </Show>
        <Show when={alone()}>
          <InlineGuidance icon="ti ti-info-circle">{t().cannotLeaveAlone}</InlineGuidance>
        </Show>
        <Show when={needsSuccessor() && !alone()}>
          <div class="flex flex-col gap-2">
            <p class="text-sm">{t().chooseSuccessor}</p>
            <Combobox
              aria-label={t().successor}
              placeholder={t().searchMembers}
              disabled={busy()}
              fetchData={async (search, signal) => {
                const found = await props.store.members(props.conversation.id, { q: search.trim().slice(0, 100) });
                if (signal.aborted) return [];
                const candidates = found.items.filter(
                  (member) => member.principal.type === "user" && member.principal.userId !== props.viewerId && !member.deactivated,
                );
                offered = new Map(candidates.map((member) => [member.accessId, member]));
                return candidates.map((member) => ({ id: member.accessId, label: member.displayName, icon: "ti-user" }));
              }}
              onSelect={(option) => setSuccessor(offered.get(option.id) ?? null)}
            />
            <Show when={successor()}>
              {(chosen) => (
                <div class="chat-member-row">
                  <MemberAvatar principal={chosen().principal} displayName={chosen().displayName} avatarHash={chosen().avatarHash} />
                  <span class="min-w-0 flex-1 truncate text-sm">{t().successorChosen({ name: chosen().displayName })}</span>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
      <Show when={error()}>
        <DialogError message={error()} />
      </Show>
      <DialogActions>
        <Button variant="secondary" disabled={busy()} onClick={() => props.close()}>
          {t().cancel}
        </Button>
        <Button variant="danger" loading={busy()} disabled={blocked()} onClick={() => void leave()}>
          {t().leaveChat}
        </Button>
      </DialogActions>
    </div>
  );
}
