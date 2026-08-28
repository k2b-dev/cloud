import { domainToASCII } from "node:url";
import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import {
  type ComposeSafetyApproval,
  type ComposeSafetyConfig,
  type ComposeSafetyReview,
  type ComposeSafetyWarning,
  composeSafetyConfigSchema,
  type DraftIntent,
  defaultComposeSafetyConfig,
  type MailAddress,
} from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";

type SafetyDraft = {
  id: string;
  revision: string | number;
  intent: DraftIntent;
  to_addresses: MailAddress[] | string;
  cc_addresses: MailAddress[] | string;
  bcc_addresses: MailAddress[] | string;
  body_markdown: string;
  body_format: "plain" | "markdown";
  attachment_names: string[] | null;
};

const safetyMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      missingAttachmentTitle: "No attachment added",
      missingAttachmentDescription: "The message mentions an attachment, but no file is attached.",
      recipientCount: ({ count }: { count: number }) => `${count} recipients`,
      recipientCountDescription: "Review the recipient list. For a private bulk message, consider using Bcc.",
      externalRecipientCount: ({ count }: { count: number }) => `${count} external recipient${count === 1 ? "" : "s"}`,
      externalRecipientDescription: "This message leaves the internal domains configured for the mailbox.",
      replyAllTitle: "Replying to everyone",
      replyAllDescription: ({ count }: { count: number }) => `This reply will be sent to ${count} people. Check whether everyone needs it.`,
      suspiciousLinkTitle: "Review message links",
      suspiciousLinkDescription: "A link uses an unusual destination or its visible address does not match where it opens.",
    },
    de: {
      missingAttachmentTitle: "Kein Anhang hinzugefügt",
      missingAttachmentDescription: "Die E-Mail erwähnt einen Anhang, enthält aber keine Datei.",
      recipientCount: ({ count }) => `${count} Empfänger`,
      recipientCountDescription: "Prüfe die Empfängerliste. Verwende für eine vertrauliche Rundmail gegebenenfalls Bcc.",
      externalRecipientCount: ({ count }) => `${count} ${count === 1 ? "externer Empfänger" : "externe Empfänger"}`,
      externalRecipientDescription: "Diese E-Mail verlässt die für das Postfach festgelegten internen Domains.",
      replyAllTitle: "Antwort an alle",
      replyAllDescription: ({ count }) => `Diese Antwort wird an ${count} Personen gesendet. Prüfe, ob alle sie benötigen.`,
      suspiciousLinkTitle: "Links in der E-Mail prüfen",
      suspiciousLinkDescription: "Ein Link verwendet ein ungewöhnliches Ziel oder seine sichtbare Adresse stimmt nicht mit dem Ziel überein.",
    },
  },
});

export type ComposeSafetySource = {
  draftId: string;
  revision: number;
  intent: DraftIntent;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  body: string;
  format: "plain" | "markdown";
  attachmentNames: string[];
  config: ComposeSafetyConfig;
};

const parseAddresses = (value: MailAddress[] | string): MailAddress[] =>
  typeof value === "string" ? (JSON.parse(value) as MailAddress[]) : value;

const normalizeDomain = (value: string): string | null => {
  const ascii = domainToASCII(value.trim().replace(/\.$/, "").toLowerCase());
  return ascii && ascii.length <= 253 ? ascii : null;
};

const recipientDomain = (address: string): string | null => {
  const separator = address.lastIndexOf("@");
  return separator < 0 ? null : normalizeDomain(address.slice(separator + 1));
};

const uniqueRecipients = (source: ComposeSafetySource): MailAddress[] => {
  const recipients = new Map<string, MailAddress>();
  for (const recipient of [...source.to, ...source.cc, ...source.bcc]) {
    const address = recipient.address.trim().toLowerCase();
    if (address && !recipients.has(address)) recipients.set(address, { ...recipient, address });
  }
  return [...recipients.values()];
};

const mentionsAttachment = (body: string): boolean => {
  const normalized = body.toLowerCase();
  if (/\b(?:not|nicht|kein(?:e|en|er|es)?)\s+(?:attached|enclosed|angeh[aä]ngt|beigef[uü]gt)\b/u.test(normalized)) return false;
  return /\b(?:attach(?:ed|ment|ments)|enclos(?:ed|ure)|anhang|anh[aä]nge|angeh[aä]ngt|beigef[uü]gt|anlage|anlagen)\b/u.test(normalized);
};

const markdownLinks = (body: string): Array<{ label: string; destination: string }> => {
  const links: Array<{ label: string; destination: string }> = [];
  for (const match of body.matchAll(/\[([^\]\n]{1,2048})\]\(([^)\s]{1,8192})(?:\s+"[^"]*")?\)/g)) {
    links.push({ label: match[1]!, destination: match[2]! });
  }
  for (const match of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)) {
    links.push({ label: match[2]!.replace(/<[^>]+>/g, "").trim(), destination: match[1]! });
  }
  return links;
};

const visibleUrlHost = (label: string): string | null => {
  const candidate = label.trim().replace(/[),.;:!?]+$/, "");
  if (!/^(?:https?:\/\/|www\.)/i.test(candidate)) return null;
  try {
    return normalizeDomain(new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate).hostname);
  } catch {
    return null;
  }
};

const suspiciousLink = (body: string, format: "plain" | "markdown"): boolean => {
  if (format !== "markdown") return false;
  return markdownLinks(body).some(({ label, destination }) => {
    let target: URL;
    try {
      target = new URL(destination);
    } catch {
      return true;
    }
    if (!["http:", "https:", "mailto:"].includes(target.protocol)) return true;
    const shownHost = visibleUrlHost(label);
    if (!shownHost || target.protocol === "mailto:") return false;
    const targetHost = normalizeDomain(target.hostname);
    return !targetHost || shownHost !== targetHost;
  });
};

export const evaluateComposeSafety = (source: ComposeSafetySource, locale = "en"): ComposeSafetyReview => {
  const t = safetyMessages.resolve([locale]).t;
  const warnings: ComposeSafetyWarning[] = [];
  const recipients = uniqueRecipients(source);
  if (source.attachmentNames.length === 0 && mentionsAttachment(source.body)) {
    warnings.push({
      id: "missing_attachment",
      title: t.missingAttachmentTitle,
      description: t.missingAttachmentDescription,
    });
  }
  if (recipients.length >= source.config.largeRecipientThreshold) {
    warnings.push({
      id: "large_recipient_set",
      title: t.recipientCount({ count: recipients.length }),
      description: t.recipientCountDescription,
    });
  }
  const internalDomains = new Set(source.config.internalDomains.map(normalizeDomain).filter((domain): domain is string => Boolean(domain)));
  const externalCount =
    internalDomains.size === 0
      ? 0
      : recipients.filter((recipient) => {
          const domain = recipientDomain(recipient.address);
          return !domain || !internalDomains.has(domain);
        }).length;
  if (externalCount > 0) {
    warnings.push({
      id: "external_recipients",
      title: t.externalRecipientCount({ count: externalCount }),
      description: t.externalRecipientDescription,
    });
  }
  if (source.intent === "reply_all" && recipients.length > 2) {
    warnings.push({
      id: "reply_all",
      title: t.replyAllTitle,
      description: t.replyAllDescription({ count: recipients.length }),
    });
  }
  if (suspiciousLink(source.body, source.format)) {
    warnings.push({
      id: "suspicious_link",
      title: t.suspiciousLinkTitle,
      description: t.suspiciousLinkDescription,
    });
  }
  const fingerprint = sha256Json({
    version: 1,
    draftId: source.draftId,
    revision: source.revision,
    intent: source.intent,
    to: source.to,
    cc: source.cc,
    bcc: source.bcc,
    body: source.body,
    format: source.format,
    attachmentNames: [...source.attachmentNames].sort(),
    config: source.config,
    warningIds: warnings.map((warning) => warning.id),
  });
  return { draftId: source.draftId, revision: source.revision, fingerprint, warnings };
};

const loadSafetySource = async (params: { db: SQL; mailboxId: string; draftId: string }): Promise<Result<ComposeSafetySource>> => {
  const [draft] = await params.db<SafetyDraft[]>`
    SELECT
      draft.id,
      draft.revision,
      draft.intent,
      draft.to_addresses,
      draft.cc_addresses,
      draft.bcc_addresses,
      draft.body_markdown,
      draft.body_format,
      COALESCE(
        array_agg(attachment.filename ORDER BY attachment.position, attachment.id)
          FILTER (WHERE attachment.id IS NOT NULL),
        ARRAY[]::text[]
      ) AS attachment_names
    FROM mail.drafts draft
    LEFT JOIN mail.draft_attachments attachment
      ON attachment.draft_id = draft.id
     AND attachment.removed_at IS NULL
    WHERE draft.id = ${params.draftId}::uuid
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND draft.origin = 'user'
      AND draft.state = 'draft'
    GROUP BY draft.id
  `;
  if (!draft) return fail(err.notFound("Draft"));
  const [mailbox] = await params.db<{ compose_safety: unknown }[]>`
    SELECT compose_safety
    FROM mail.mailboxes
    WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const config = composeSafetyConfigSchema.catch(defaultComposeSafetyConfig()).parse(mailbox.compose_safety);
  return ok({
    draftId: draft.id,
    revision: Number(draft.revision),
    intent: draft.intent,
    to: parseAddresses(draft.to_addresses),
    cc: parseAddresses(draft.cc_addresses),
    bcc: parseAddresses(draft.bcc_addresses),
    body: draft.body_markdown,
    format: draft.body_format,
    attachmentNames: draft.attachment_names ?? [],
    config,
  });
};

export const reviewDraftComposeSafety = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
  locale?: string;
}): Promise<Result<ComposeSafetyReview>> => {
  return sql.begin(async (tx) => {
    const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
    if (!allowed.ok) return allowed;
    const source = await loadSafetySource({ db: tx, mailboxId: params.mailboxId, draftId: params.draftId });
    if (!source.ok) return source;
    if (source.data.revision !== params.expectedRevision) return fail(err.conflict("Draft changed before safety review"));
    return ok(evaluateComposeSafety(source.data, params.locale));
  });
};

export const validateDraftComposeSafety = async (params: {
  db: SQL;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
  approval?: ComposeSafetyApproval;
}): Promise<Result<ComposeSafetyReview>> => {
  const source = await loadSafetySource(params);
  if (!source.ok) return source;
  if (source.data.revision !== params.expectedRevision) return fail(err.conflict("Draft changed before sending"));
  const review = evaluateComposeSafety(source.data);
  if (review.warnings.length === 0) return ok(review);
  const expectedIds = review.warnings.map((warning) => warning.id).sort();
  const approvedIds = [...new Set(params.approval?.warningIds ?? [])].sort();
  if (
    params.approval?.revision !== review.revision ||
    params.approval.fingerprint !== review.fingerprint ||
    expectedIds.length !== approvedIds.length ||
    expectedIds.some((id, index) => id !== approvedIds[index])
  ) {
    return fail(err.conflict("Review the current message safety warnings before sending"));
  }
  return ok(review);
};
