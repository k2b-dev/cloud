import { type AssistantLaunch, type LaunchAssistantInput, launchAssistant } from "@k2b/cloud/ai/browser";
import { contactOpenHref } from "../../app-integration-contracts";
import type { MailAddress } from "../../contracts";
import { resolveContacts } from "./contact-capabilities";
import { mailDraftHref } from "./mail-compose-route";
import { mailRemainingMessages } from "./mail-remaining-messages";

const CONTACT_EMAIL_LIMIT = 25;
const CONTACT_RESOURCE_LIMIT = 5;
const CONTACT_RESOLVE_RESULT_LIMIT = 50;

type AssistantResourcePart = Extract<NonNullable<LaunchAssistantInput["draft"]>["content"][number], { type: "resource" }>;

type ResolvedContacts = Awaited<ReturnType<typeof resolveContacts>>;

const mailTools: NonNullable<LaunchAssistantInput["preloadTools"]> = [
  { name: "text_editor" },
  { appId: "mail", kind: "query", id: "draft.read" },
  { appId: "mail", kind: "action", id: "draft.update" },
  { appId: "mail", kind: "action", id: "draft.send" },
  { appId: "mail", kind: "query", id: "conversation.search" },
  { appId: "mail", kind: "query", id: "conversation.related" },
];

const contactCapability: NonNullable<LaunchAssistantInput["preloadTools"]>[number] = {
  appId: "contacts",
  kind: "query",
  id: "contact.resolve",
};

export const mailAssistantRecipientEmails = (recipients: readonly MailAddress[]): string[] => {
  const emails = new Set<string>();
  for (const recipient of recipients) {
    const email = recipient.address.trim().toLowerCase();
    if (!email || emails.has(email)) continue;
    emails.add(email);
    if (emails.size === CONTACT_EMAIL_LIMIT) break;
  }
  return [...emails];
};

export const mailAssistantContactResources = (emails: readonly string[], resolution: ResolvedContacts): AssistantResourcePart[] => {
  if (resolution.page?.hasMore) return [];

  const requestedEmails = new Set(emails);
  const contactsByEmail = new Map<string, Map<string, (typeof resolution.data.items)[number]>>();
  for (const contact of resolution.data.items) {
    for (const value of contact.matchedEmails) {
      const email = value.trim().toLowerCase();
      if (!requestedEmails.has(email)) continue;
      const matches = contactsByEmail.get(email) ?? new Map();
      matches.set(contact.contactId, contact);
      contactsByEmail.set(email, matches);
    }
  }

  const resources: AssistantResourcePart[] = [];
  const attachedContactIds = new Set<string>();
  for (const email of emails) {
    const matches = contactsByEmail.get(email);
    if (matches?.size !== 1) continue;
    const contact = matches.values().next().value;
    if (!contact || attachedContactIds.has(contact.contactId)) continue;
    attachedContactIds.add(contact.contactId);
    const href = contactOpenHref(contact.links);
    resources.push({
      type: "resource",
      ref: { type: "contacts.contact", id: contact.contactId },
      title: contact.displayName,
      icon: "ti ti-address-book",
      ...(href ? { href } : {}),
    });
    if (resources.length === CONTACT_RESOURCE_LIMIT) break;
  }
  return resources;
};

export const launchMailDraftAssistant = async (input: {
  mailboxId: string;
  returnHref: string;
  draft: {
    id: string;
    subject: string;
    to: MailAddress[];
    cc: MailAddress[];
    bcc: MailAddress[];
  };
}): Promise<AssistantLaunch> => {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const messages = mailRemainingMessages.resolve([locale]).t;
  const emails = mailAssistantRecipientEmails([...input.draft.to, ...input.draft.cc, ...input.draft.bcc]);
  let contactsAvailable = false;
  let contactResources: AssistantResourcePart[] = [];
  if (emails.length > 0) {
    try {
      const resolution = await resolveContacts({ emails, limit: CONTACT_RESOLVE_RESULT_LIMIT });
      contactsAvailable = true;
      contactResources = mailAssistantContactResources(emails, resolution);
    } catch {
      // Contact context is optional and must never prevent writing the draft.
    }
  }

  const title = input.draft.subject.trim();
  return launchAssistant({
    launchedByAppId: "mail",
    title: title || messages.writeEmail,
    draft: {
      content: [
        { type: "text", text: messages.assistantWriteEmailPrompt },
        {
          type: "resource",
          ref: { type: "mail.draft", id: input.draft.id },
          title: title || messages.mailDraft,
          icon: "ti ti-file-pencil",
          href: mailDraftHref(input.mailboxId, input.draft.id, input.returnHref),
        },
        ...contactResources,
      ],
    },
    preloadTools: [...mailTools, ...(contactsAvailable ? [contactCapability] : [])],
  });
};
