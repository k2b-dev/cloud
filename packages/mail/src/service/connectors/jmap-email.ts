import { z } from "zod";
import { mailKeywordSchema } from "../../contracts";
import { extractMessageProtocolFacts } from "../message-protocol";
import type { ConnectorAddress, ProjectionEnvelope } from "./contract";
import { jmapIdSchema } from "./jmap-client";

const addressList = z.array(z.object({ name: z.string().nullish(), email: z.string() })).nullish();
const messageIds = z.array(z.string()).nullish();
const rawHeader = z.string().nullable();
const rawHeaders = {
  "header:Return-Path:asRaw": rawHeader,
  "header:Auto-Submitted:asRaw": rawHeader,
  "header:Precedence:asRaw": rawHeader,
  "header:List-Id:asRaw": rawHeader,
  "header:List-Unsubscribe:asRaw": rawHeader,
  "header:List-Unsubscribe-Post:asRaw": rawHeader,
  "header:List-Post:asRaw": rawHeader,
  "header:List-Help:asRaw": rawHeader,
  "header:List-Archive:asRaw": rawHeader,
  "header:X-Auto-Response-Suppress:asRaw": rawHeader,
  "header:Content-Type:asRaw": rawHeader,
  "header:Importance:asRaw": rawHeader,
  "header:Priority:asRaw": rawHeader,
  "header:X-Priority:asRaw": rawHeader,
  "header:Disposition-Notification-To:asRaw": rawHeader,
  "header:X-Spam-Flag:asRaw": rawHeader,
  "header:X-Spam-Status:asRaw": rawHeader,
  "header:X-Spam-Score:asRaw": rawHeader,
};

const bodyPartSchema = z.object({
  // MIME part paths (such as "1.2") are strings, not RFC 8620 Id values.
  partId: z.string().nullable(),
  type: z.string(),
  charset: z.string().nullable(),
  name: z.string().nullable(),
  cid: z.string().nullable(),
  disposition: z.string().nullable(),
  size: z.number().int().nonnegative(),
  get subParts() {
    return z.array(bodyPartSchema).nullable();
  },
});
export const jmapEmailSnapshotSchema = z.object({
  id: jmapIdSchema,
  blobId: jmapIdSchema,
  threadId: jmapIdSchema,
  mailboxIds: z.record(jmapIdSchema, z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  size: z.number().int().nonnegative(),
  receivedAt: z.string().datetime(),
  sentAt: z.string().datetime({ offset: true }).nullish(),
  subject: z.string().nullable(),
  from: addressList,
  to: addressList,
  cc: addressList,
  bcc: addressList,
  replyTo: addressList,
  messageId: messageIds,
  inReplyTo: messageIds,
  references: messageIds,
  hasAttachment: z.boolean(),
  bodyStructure: bodyPartSchema,
  ...rawHeaders,
});
export type JmapEmailSnapshot = z.infer<typeof jmapEmailSnapshotSchema>;
export const JMAP_EMAIL_PROPERTIES = Object.keys(jmapEmailSnapshotSchema.shape);
export const JMAP_EMAIL_BODY_PROPERTIES = Object.keys(bodyPartSchema.shape);

const keywordFlags = new Map([
  ["$seen", "\\Seen"],
  ["$flagged", "\\Flagged"],
  ["$answered", "\\Answered"],
  ["$draft", "\\Draft"],
]);

export function mapJmapKeywords(keywords: JmapEmailSnapshot["keywords"]) {
  const flags: string[] = [];
  const labels: string[] = [];
  let skippedKeywordCount = 0;
  for (const [keyword, enabled] of Object.entries(keywords)) {
    if (!enabled) continue;
    const flag = keywordFlags.get(keyword);
    if (flag) flags.push(flag);
    else {
      const parsed = mailKeywordSchema.safeParse(keyword);
      if (parsed.success && parsed.data === keyword) labels.push(keyword);
      else skippedKeywordCount++;
    }
  }
  return { flags: flags.sort(), labels: labels.sort(), skippedKeywordCount };
}

/** Only the four mapped flags; never replace the provider's complete keyword map with this. */
export function jmapKeywordsFromFlags(flags: readonly string[]): Record<string, true> {
  const present = new Set(flags.map((flag) => flag.toLowerCase()));
  return Object.fromEntries(
    [...keywordFlags].filter(([, flag]) => present.has(flag.toLowerCase())).map(([keyword]) => [keyword, true] as const),
  );
}

const withoutNul = (value: string): string => value.replaceAll("\u0000", "");

function mapAddresses(addresses: z.infer<typeof addressList>): ConnectorAddress[] {
  return (addresses ?? []).flatMap(({ name, email }) => {
    const address = withoutNul(email).trim().toLowerCase();
    return address ? [{ name: (name && withoutNul(name).trim()) || null, address }] : [];
  });
}

function bracketMessageId(value: string | undefined): string | null {
  const id = value && withoutNul(value).trim();
  return id ? `<${id}>` : null;
}

export function mapJmapMimeStructure(part: JmapEmailSnapshot["bodyStructure"]): Record<string, unknown> {
  return {
    part: part.partId === null ? null : withoutNul(part.partId),
    type: withoutNul(part.type),
    parameters: {
      ...(part.charset === null ? {} : { charset: withoutNul(part.charset) }),
      ...(part.name === null ? {} : { name: withoutNul(part.name) }),
    },
    id: part.cid === null ? null : withoutNul(part.cid),
    encoding: null,
    // JMAP sizes are decoded. HTML hydration must budget from the full source size.
    size: withoutNul(part.type).toLowerCase() === "text/html" ? null : part.size,
    disposition: part.disposition === null ? null : withoutNul(part.disposition),
    dispositionParameters: {},
    childNodes: (part.subParts ?? []).map(mapJmapMimeStructure),
  };
}

/** Content is normalized once; the later projection supplies a folder-bound remoteRef. */
export function mapJmapEmailSnapshot(email: JmapEmailSnapshot) {
  const { flags, labels, skippedKeywordCount } = mapJmapKeywords(email.keywords);
  const headers = new Map(
    Object.entries(email)
      .filter(([key]) => Object.hasOwn(rawHeaders, key))
      .map(([key, value]) => [key.slice(7, -6).toLowerCase(), typeof value === "string" ? withoutNul(value) : null]),
  );
  const envelope: Omit<ProjectionEnvelope, "remoteRef"> = {
    providerMessageId: null,
    providerThreadId: email.threadId,
    messageId: bracketMessageId(email.messageId?.[0]),
    inReplyTo: bracketMessageId(email.inReplyTo?.[0]),
    references: (email.references ?? []).map(bracketMessageId).filter((id): id is string => id !== null),
    protocolFacts: extractMessageProtocolFacts((name) => headers.get(name)),
    subject: withoutNul(email.subject ?? ""),
    sentAt: email.sentAt ? new Date(email.sentAt) : null,
    internalDate: new Date(email.receivedAt),
    sizeBytes: email.size,
    flags,
    labels,
    addresses: {
      from: mapAddresses(email.from),
      to: mapAddresses(email.to),
      cc: mapAddresses(email.cc),
      bcc: mapAddresses(email.bcc),
      replyTo: mapAddresses(email.replyTo),
    },
    mimeStructure: mapJmapMimeStructure(email.bodyStructure),
  };
  return {
    emailId: email.id,
    mailboxIds: Object.entries(email.mailboxIds)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),
    blobId: email.blobId,
    hasAttachment: email.hasAttachment,
    envelope,
    skippedKeywordCount,
  };
}
