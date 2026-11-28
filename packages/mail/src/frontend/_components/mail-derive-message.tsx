import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CheckboxCard, prompts, Select, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DeriveDraftFromMessageInput, DraftDerivationKind, MailDraft, MailDraftSeed, SenderIdentity } from "../../contracts";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import { openDraftWindow } from "./mail-compose-windows";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

type DeriveChoice = Omit<DeriveDraftFromMessageInput, "idempotencyKey">;

/**
 * "Use as new" for one message: the person picks the sender and whether the attachments come along, the server derives
 * a draft from the message, and it opens as a window over the mailbox, as a new message does. One at a time: while the
 * draft is on its way, `busy` holds and a second request is dropped. A failure says why; a change of mailbox aborts it.
 * The v1 reader and the v2 pilot use this.
 */
export function createMailMessageDerive(props: {
  mailboxId: () => string;
  identities: () => readonly SenderIdentity[];
  /** What the reader shows; a choice made after it changed is dropped. */
  selection: () => string | null;
  /** The reader still shows this message. */
  shows: (messageId: string) => boolean;
  /** Without a verified sender: says why, as the reply does. */
  explainSenderUnavailable: () => unknown;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  // A seed whose draft has no answer yet: a second try of the same choice materializes it again, so a lost answer
  // makes no second draft (as Compose's pending seed). The key is the mailbox, the message and the choice.
  let pendingSeed: { key: string; seed: MailDraftSeed } | null = null;
  const request = createMemo(
    on(props.mailboxId, (mailboxId) => {
      let active = true;
      const current = mutations.create<
        MailDraft,
        { message: MailWorkspaceMessage; input: DeriveChoice; trigger: HTMLElement | null },
        { trigger: HTMLElement | null; progress: ToastHandle }
      >({
        // the same quiet progress as a new message, until the window opens
        onBefore: ({ trigger }) => ({
          trigger,
          progress: toast(t().preparingMessage, { progress: "indeterminate", duration: 0, iconClass: "ti ti-pencil" }),
        }),
        mutation: async ({ message, input }, { abortSignal }) => {
          if (!active) throw new DOMException("Mailbox changed", "AbortError");
          const key = JSON.stringify([mailboxId, message.id, input.kind, input.senderIdentityId, input.includeAttachments]);
          const seed = pendingSeed?.key === key ? pendingSeed.seed : await createSeed(mailboxId, message, input, abortSignal);
          pendingSeed = { key, seed };
          // the seed becomes the draft at once; its ID keeps a repeated answer to one draft
          const materialized = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].materialize.$post(
            { param: { mailboxId }, json: { idempotencyKey: seed.id, origin: seed.origin, draft: seed.content } },
            { init: { signal: abortSignal } },
          );
          if (!materialized.ok) throw new Error(await readApiError(materialized, t().createFromMessageFailed));
          const draft: MailDraft = await materialized.json();
          pendingSeed = null;
          return draft;
        },
        onSuccess: (draft, context) => {
          context?.progress.dismiss();
          if (disposed) return;
          // another mailbox took the workspace meanwhile: a fresh draft goes again instead of waiting unseen
          if (!active) {
            if (draft.creationOutcome === "created")
              void apiClient.mailboxes[":mailboxId"].drafts[":draftId"].discard
                .$post({ param: { mailboxId, draftId: draft.id }, json: { expectedRevision: draft.revision } })
                .catch(() => undefined);
            return;
          }
          // the window belongs to the mailbox, not to the conversation: it opens even when another one is shown now
          openDraftWindow(draft.id, {
            mailboxId,
            initialDraft: draft,
            fresh: draft.creationOutcome === "created",
            returnFocus: context?.trigger ?? null,
          });
        },
        onError: (error, context) => {
          context?.progress.dismiss();
          prompts.error(error.message);
        },
      });
      onCleanup(() => {
        active = false;
        current.abort();
      });
      return current;
    }),
  );
  const createSeed = async (mailboxId: string, message: MailWorkspaceMessage, input: DeriveChoice, abortSignal: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
      {
        param: { mailboxId },
        json: {
          origin: {
            kind: "derive",
            messageId: message.id,
            input: { kind: input.kind, senderIdentityId: input.senderIdentityId, includeAttachments: input.includeAttachments },
          },
        },
      },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().createFromMessageFailed));
    const created: MailDraftSeed = await response.json();
    return created;
  };
  const busy = () => request().loading();
  const derive = async (kind: DraftDerivationKind, message: MailWorkspaceMessage) => {
    const instance = request();
    if (instance.loading()) return;
    // the window gives the focus back to what started it, as a new message does
    const trigger =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const selection = props.selection();
    const identities = props.identities().filter((identity) => identity.status === "verified");
    const defaultIdentity = identities.find((identity) => identity.isDefault) ?? identities[0];
    if (!defaultIdentity) return void props.explainSenderUnavailable();
    const choice = await prompts.dialog<DeriveChoice>(
      (close) => {
        const [senderIdentityId, setSenderIdentityId] = createSignal(defaultIdentity.id);
        const [includeAttachments, setIncludeAttachments] = createSignal(message.attachments.length > 0);
        return (
          <div class="flex flex-col gap-3">
            <p class="text-sm text-secondary">{t().deriveDescription}</p>
            <Select
              label={t().sendFrom}
              value={senderIdentityId}
              onValueChange={setSenderIdentityId}
              options={identities.map((identity) => ({ id: identity.id, label: identity.label }))}
            />
            <Show when={message.attachments.length > 0}>
              <CheckboxCard
                label={t().includeAttachments({ count: message.attachments.length })}
                value={includeAttachments}
                onValueChange={setIncludeAttachments}
              />
            </Show>
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => close({ kind, senderIdentityId: senderIdentityId(), includeAttachments: includeAttachments() })}
              >
                <i class="ti ti-file-pencil" aria-hidden="true" /> {t().continue}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().useAsNew, icon: "ti ti-copy", size: "small" },
    );
    // Another mailbox, conversation or message opened while the dialog was open: the choice was for that one.
    if (!choice || disposed || instance !== request() || selection !== props.selection() || !props.shows(message.id)) return;
    instance.mutate({ message, input: choice, trigger });
  };
  return { derive, busy, abort: () => request().abort() };
}
