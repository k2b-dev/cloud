import { importOnDemand } from "@k2b/cloud/browser/reload";
import { documentNavigate } from "@k2b/ssr/nav";
import { Button, CheckboxCard, prompts, Select } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DeriveDraftFromMessageInput, DraftDerivationKind, SenderIdentity } from "../../contracts";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import { mailDraftSeedHref } from "./mail-compose-route";
import type { mailConversationUiMessages } from "./mail-conversation-ui-messages";

type MailConversationText = ReturnType<typeof mailConversationUiMessages.resolve>["t"];

/**
 * "Use as new" for one message, as v1's reader does it (MailConversationReader `deriveMessage`): the person picks the
 * sender and whether the attachments come along, the server derives a draft seed from the message, and the compose
 * page opens with it. Used by Mail's v2 pilot; v1's reader keeps its own copy of the same steps until it moves here.
 */
export async function deriveMailMessage(options: {
  kind: DraftDerivationKind;
  message: MailWorkspaceMessage;
  mailboxId: string;
  identities: readonly SenderIdentity[];
  currentUserId: string;
  /** Where the compose page returns to. */
  returnHref: string;
  t: MailConversationText;
  /** Without a verified sender: says why, as the reply does. */
  explainSenderUnavailable: () => unknown;
  /** The reader still shows this message; a choice made after it changed is dropped. */
  stillCurrent: () => boolean;
}): Promise<void> {
  const { t, message } = options;
  const identities = options.identities.filter((identity) => identity.status === "verified");
  const defaultIdentity = identities.find((identity) => identity.isDefault) ?? identities[0];
  if (!defaultIdentity) return void options.explainSenderUnavailable();
  const choice = await prompts.dialog<Omit<DeriveDraftFromMessageInput, "idempotencyKey">>(
    (close) => {
      const [senderIdentityId, setSenderIdentityId] = createSignal(defaultIdentity.id);
      const [includeAttachments, setIncludeAttachments] = createSignal(message.attachments.length > 0);
      return (
        <div class="flex flex-col gap-3">
          <p class="text-sm text-secondary">{t.deriveDescription}</p>
          <Select
            label={t.sendFrom}
            value={senderIdentityId}
            onValueChange={setSenderIdentityId}
            options={identities.map((identity) => ({ id: identity.id, label: identity.label }))}
          />
          <Show when={message.attachments.length > 0}>
            <CheckboxCard
              label={t.includeAttachments({ count: message.attachments.length })}
              value={includeAttachments}
              onValueChange={setIncludeAttachments}
            />
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              {t.cancel}
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={() => close({ kind: options.kind, senderIdentityId: senderIdentityId(), includeAttachments: includeAttachments() })}
            >
              <i class="ti ti-file-pencil" aria-hidden="true" /> {t.continue}
            </Button>
          </div>
        </div>
      );
    },
    { title: t.useAsNew, icon: "ti ti-copy", size: "small" },
  );
  if (!choice || !options.stillCurrent()) return;
  const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post({
    param: { mailboxId: options.mailboxId },
    json: {
      origin: {
        kind: "derive",
        messageId: message.id,
        input: { kind: choice.kind, senderIdentityId: choice.senderIdentityId, includeAttachments: choice.includeAttachments },
      },
    },
  });
  if (!response.ok) return void prompts.error(await readApiError(response, t.createFromMessageFailed));
  const seed = await response.json();
  if (!options.stillCurrent()) return;
  const store = await importOnDemand(() => import("./mail-draft-seed-store"));
  if (!store || !options.stillCurrent()) return;
  try {
    store.storeMailDraftSeed(openMailUserDraftStorage(localStorage, options.currentUserId), seed);
  } catch {
    return void prompts.error(t.localDraftFailed, { title: t.startMessageFailed });
  }
  documentNavigate(mailDraftSeedHref(options.mailboxId, seed.id, options.returnHref, { popout: false }));
}
