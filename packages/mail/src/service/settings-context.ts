import { sql } from "@k2b/cloud";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { RequestAuthority } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import type { SenderIdentity } from "../contracts";
import type { MailboxCodeSummary, MailboxSettingsContext } from "../settings-context";
import * as mailboxAccess from "./access";
import { getSpacesMailIntegrationAvailability } from "./app-integrations";
import type { MailRequestContext } from "./auth";
import * as bindings from "./bindings";
import * as composeTemplates from "./compose-templates";
import * as folders from "./folders";
import * as localTags from "./local-tags";
import * as mailboxes from "./mailboxes";
import * as providerConnections from "./provider-connections";
import * as savedViews from "./saved-views";
import * as senderIdentities from "./sender-identities";

const CodeSummarySchema = z.object({
  items: z.array(z.object({ automations: z.number(), access: z.array(z.object({ title: z.string(), count: z.number() })) })),
});
/** Settings open without these numbers when Core is slow. Core asks this app back about the owner, so it needs a moment. */
const CODE_SUMMARY_TIMEOUT_MS = 2_000;

/** Asks Core through its public query with the person's own credentials, like any application. No answer means null. */
const loadMailboxCodeSummary = async (mailboxId: string, caller: CapabilityCaller, locale?: string): Promise<MailboxCodeSummary | null> => {
  try {
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (!row) return null;
    const timeout = AbortSignal.timeout(CODE_SUMMARY_TIMEOUT_MS);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.summary",
        kind: "query",
        input: { owner: { kind: "resource", ref: { type: "mail.mailbox", id: row.short_id } } },
      },
      CodeSummarySchema,
      { ...caller, locale, signal: caller.signal ? AbortSignal.any([caller.signal, timeout]) : timeout },
    );
    if (!result.ok) return null;
    const items = result.data.data.items;
    const access = new Map<string, number>();
    for (const item of items) for (const entry of item.access) access.set(entry.title, (access.get(entry.title) ?? 0) + entry.count);
    return {
      exists: items.length > 0,
      automations: items.reduce((sum, item) => sum + item.automations, 0),
      access: [...access].map(([title, count]) => ({ title, count })),
    };
  } catch {
    return null;
  }
};

/** Mails in this mailbox, each once however many folders hold it, without drafts. Null keeps the settings usable. */
const countMailboxMessages = async (mailboxId: string): Promise<number | null> => {
  try {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT placement.message_id)::int AS count
      FROM mail.message_placements placement
      JOIN mail.folders f ON f.id = placement.folder_id
      JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
      WHERE rr.mailbox_id = ${mailboxId}::uuid AND placement.deleted_at IS NULL AND f.role <> 'drafts'
    `;
    return row?.count ?? null;
  } catch {
    return null;
  }
};

export const loadMailboxSettingsContext = async (
  context: MailRequestContext,
  mailboxId: string,
  authority: RequestAuthority | null,
  caller: CapabilityCaller = {},
  locale?: string,
): Promise<Result<MailboxSettingsContext>> => {
  const permission = await mailboxAccess.getMailboxPermission(context, mailboxId);
  if (permission === "none") return fail(err.forbidden("Access denied"));

  const mailboxResult = await mailboxes.getMailbox(context, mailboxId);
  if (!mailboxResult.ok) return fail(mailboxResult.error);
  const [savedViewResult, localTagResult, spacesIntegration] = await Promise.all([
    savedViews.listSavedConversationViews({ context, mailboxId }),
    localTags.listLocalTags(context, mailboxId),
    getSpacesMailIntegrationAvailability(authority),
  ]);
  if (!savedViewResult.ok) return fail(savedViewResult.error);
  if (!localTagResult.ok) return fail(localTagResult.error);
  const organization = {
    savedViews: savedViewResult.data,
    localTags: localTagResult.data,
  };
  const integrations = { spacesCalendar: spacesIntegration.settings };

  let compose: MailboxSettingsContext["compose"] = null;
  let composeIdentities: SenderIdentity[] = [];
  if (permission === "write" || permission === "admin") {
    const [templateResult, defaultResult, styleResult, identityResult] = await Promise.all([
      composeTemplates.listComposeTemplates(context, mailboxId),
      composeTemplates.listComposeSignatureDefaults(context, mailboxId),
      composeTemplates.getMailboxComposeStyle(context, mailboxId),
      senderIdentities.listSenderIdentities(context, mailboxId),
    ]);
    if (!templateResult.ok) return fail(templateResult.error);
    if (!defaultResult.ok) return fail(defaultResult.error);
    if (!styleResult.ok) return fail(styleResult.error);
    if (!identityResult.ok) return fail(identityResult.error);
    composeIdentities = identityResult.data;
    compose = {
      templates: templateResult.data,
      defaults: defaultResult.data,
      style: styleResult.data,
      identities: composeIdentities,
    };
  }

  if (permission !== "admin") {
    return ok({ mailbox: mailboxResult.data, permission, integrations, organization, compose, admin: null });
  }

  const [accessResult, connectionResult, bindingResult, adminFolderResult, code, messageCount] = await Promise.all([
    mailboxAccess.listMailboxAccess(context, mailboxId),
    providerConnections.listProviderConnections(context, mailboxId),
    bindings.listProviderBindings(context, mailboxId),
    folders.listAdminFolders(context, mailboxId),
    loadMailboxCodeSummary(mailboxId, caller, locale),
    countMailboxMessages(mailboxId),
  ]);
  if (!accessResult.ok) return fail(accessResult.error);
  if (!connectionResult.ok) return fail(connectionResult.error);
  if (!bindingResult.ok) return fail(bindingResult.error);
  if (!adminFolderResult.ok) return fail(adminFolderResult.error);
  return ok({
    mailbox: mailboxResult.data,
    permission,
    integrations,
    organization,
    compose,
    admin: {
      accessEntries: accessResult.data,
      code,
      messageCount,
      connections: connectionResult.data,
      bindings: bindingResult.data,
      folders: adminFolderResult.data,
      identities: composeIdentities,
    },
  });
};
