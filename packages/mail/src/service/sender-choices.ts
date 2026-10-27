import { summarizeAccessAudience } from "@k2b/cloud/server";
import { ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { SenderChoice } from "../contracts";
import { requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listComposeSignatureDefaults, listComposeTemplates } from "./compose-templates";
import { listSenderIdentities } from "./sender-identities";

/** The same authorized identity/default readers used by compose; never expands mailbox access. */
export const listSenderChoices = async (context: MailRequestContext, mailboxId: string, db = sql): Promise<Result<SenderChoice[]>> => {
  const allowed = await requireMailboxAccess(context, mailboxId, "write");
  if (!allowed.ok) return allowed;
  const identities = await listSenderIdentities(context, mailboxId);
  if (!identities.ok) return identities;
  const templates = await listComposeTemplates(context, mailboxId);
  if (!templates.ok) return templates;
  const defaults = await listComposeSignatureDefaults(context, mailboxId);
  if (!defaults.ok) return defaults;
  let audience: SenderChoice["audience"] = null;
  let assignedReaders: SenderChoice["assignedReaders"] = null;
  if (allowed.data.scope === "mailbox") {
    const grants = await db<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
    `;
    audience = await summarizeAccessAudience({ accessIds: grants.map((row) => row.access_id), db });
    const [assigned] = await db<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM mail.mailbox_assigned_access ma JOIN auth.access a ON a.id = ma.access_id
        WHERE ma.mailbox_id = ${mailboxId}::uuid AND a.permission IN ('read', 'write', 'admin')) AS exists
    `;
    assignedReaders = assigned?.exists ?? false;
  }
  return ok(
    identities.data.map((identity) => {
      const personal = defaults.data.find((entry) => entry.senderIdentityId === identity.id && entry.userId !== null);
      const signature = [personal?.templateId, identity.defaultSignatureTemplateId].flatMap((id) =>
        templates.data.filter((template) => template.id === id && template.kind === "signature"),
      )[0];
      return {
        id: identity.id,
        label: identity.label,
        displayName: identity.displayName,
        fromAddress: identity.fromAddress,
        status: identity.status,
        replyTo: identity.replyTo ?? identity.fromAddress,
        defaultCc: identity.defaultCc,
        defaultBcc: identity.defaultBcc,
        signatureName: signature?.name ?? null,
        audience,
        assignedReaders,
      };
    }),
  );
};
