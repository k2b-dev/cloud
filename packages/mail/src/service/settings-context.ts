import type { RequestAuthority } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SenderIdentity } from "../contracts";
import type { MailboxSettingsContext } from "../settings-context";
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

export const loadMailboxSettingsContext = async (
  context: MailRequestContext,
  mailboxId: string,
  authority: RequestAuthority | null,
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

  const [accessResult, connectionResult, bindingResult, adminFolderResult] = await Promise.all([
    mailboxAccess.listMailboxAccess(context, mailboxId),
    providerConnections.listProviderConnections(context, mailboxId),
    bindings.listProviderBindings(context, mailboxId),
    folders.listAdminFolders(context, mailboxId),
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
      connections: connectionResult.data,
      bindings: bindingResult.data,
      folders: adminFolderResult.data,
      identities: composeIdentities,
    },
  });
};
