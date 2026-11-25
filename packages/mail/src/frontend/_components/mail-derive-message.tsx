import { importOnDemand } from "@k2b/cloud/browser/reload";
import { documentNavigate } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CheckboxCard, prompts, Select, useLocale } from "@k2b/ui";
import { createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DeriveDraftFromMessageInput, DraftDerivationKind, MailDraftSeed, SenderIdentity } from "../../contracts";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import { mailDraftSeedHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

type DeriveChoice = Omit<DeriveDraftFromMessageInput, "idempotencyKey">;

/**
 * "Use as new" for one message: the person picks the sender and whether the attachments come along, the server derives
 * a draft seed from the message, and the compose page opens with it. One at a time: while a seed is on its way, `busy`
 * holds and a second request is dropped. A failure says why; a change of mailbox aborts it. The v1 reader and the v2
 * pilot use this.
 */
export function createMailMessageDerive(props: {
  mailboxId: () => string;
  identities: () => readonly SenderIdentity[];
  currentUserId: () => string | null;
  /** Where the compose page returns to. */
  returnHref: () => string;
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
  const openSeed = async (seed: MailDraftSeed, stillCurrent: () => boolean) => {
    const store = await importOnDemand(() => import("./mail-draft-seed-store"));
    const userId = props.currentUserId();
    if (!store || disposed || !stillCurrent()) return;
    try {
      if (!userId) throw new Error(t().localDraftFailed);
      store.storeMailDraftSeed(openMailUserDraftStorage(localStorage, userId), seed);
    } catch {
      return void prompts.error(t().localDraftFailed, { title: t().startMessageFailed });
    }
    documentNavigate(mailDraftSeedHref(props.mailboxId(), seed.id, props.returnHref(), { popout: false }));
  };
  const request = createMemo(
    on(props.mailboxId, (mailboxId) => {
      let active = true;
      const current = mutations.create<
        MailDraftSeed,
        { message: MailWorkspaceMessage; input: DeriveChoice },
        { message: MailWorkspaceMessage }
      >({
        onBefore: ({ message }) => ({ message }),
        mutation: async ({ message, input }, { abortSignal }) => {
          if (!active) throw new DOMException("Mailbox changed", "AbortError");
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
          return response.json();
        },
        onSuccess: (seed, context) => {
          if (context && active && props.shows(context.message.id)) void openSeed(seed, () => active && props.shows(context.message.id));
        },
        onError: (error) => prompts.error(error.message),
      });
      onCleanup(() => {
        active = false;
        current.abort();
      });
      return current;
    }),
  );
  const busy = () => request().loading();
  const derive = async (kind: DraftDerivationKind, message: MailWorkspaceMessage) => {
    const instance = request();
    if (instance.loading()) return;
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
    instance.mutate({ message, input: choice });
  };
  return { derive, busy, abort: () => request().abort() };
}
