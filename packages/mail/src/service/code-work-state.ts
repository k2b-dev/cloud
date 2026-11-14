import type { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { MailRequestContext } from "./auth";

/** Run under the conversation locks, before any single or batch collaboration write. */
export async function requireCodeWorkStateEligibility(options: {
  context: MailRequestContext;
  mailboxId: string;
  conversationIds: string[];
  db: typeof sql;
}): Promise<Result> {
  const { actor } = options.context;
  const codeAccount = actor.kind === "service_account" && actor.serviceAccount.kind === "code";
  if (!codeAccount && actor.delegation?.workloadType !== "code.version") return ok();
  const refused = () => fail(err.forbidden("This message does not support automatic conversation work changes."));
  if (
    actor.delegation?.credentialKind !== "mandate" ||
    actor.delegation.workloadType !== "code.version" ||
    !actor.delegation.workloadRun ||
    actor.delegation.workloadTrigger === undefined
  )
    return refused();
  const event = actor.delegation.workloadTrigger;
  if (!event || event.type !== "mail.message.received") return ok();
  if (event.subject.type !== "mail.message" || event.place?.type !== "mail.mailbox") return refused();
  const [message] = await options.db<{ id: string }[]>`SELECT message.id FROM mail.message_contents message
    JOIN mail.mailboxes box ON box.id=message.mailbox_id
    WHERE message.short_id=${event.subject.id} AND message.mailbox_id=${options.mailboxId}::uuid
      AND box.short_id=${event.place.id}`;
  if (!message) return refused();
  // Conversation locks fence new membership; existing links stay stable below.
  // Do not lock the message after its conversation: hydration uses the reverse order.
  const links = await options.db<{ added_by: string }[]>`SELECT link.added_by FROM mail.conversation_messages link
    WHERE link.message_id=${message.id}::uuid
      AND link.conversation_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${options.conversationIds}::jsonb))
    FOR SHARE OF link`;
  return links.some((link) => link.added_by === "list") ? refused() : ok();
}
