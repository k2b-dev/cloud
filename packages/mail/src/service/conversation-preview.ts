import { markdown } from "@k2b/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { convert, type HtmlToTextOptions } from "html-to-text";
import { requireMailboxAccess, requireVisibleConversation } from "./access";
import { attachmentMimeOrder } from "./attachment-order";
import type { MailRequestContext } from "./auth";
import { isUnsentOutboundMessage } from "./conversation-timeline";

/**
 * Text budgets of the quick look card. The card is 22rem x 20rem: the excerpt
 * shows about twelve lines of about sixty characters and the summary three
 * lines, so these limits keep every visible character with headroom for
 * narrow glyphs while bounding the response.
 */
export const MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH = 1_000;
export const MAIL_CONVERSATION_PREVIEW_SUMMARY_MAX_LENGTH = 500;
/** Sender, assignee, and attachment names fill at most one line of the card. */
export const MAIL_CONVERSATION_PREVIEW_NAME_MAX_LENGTH = 200;
/** The longest address SMTP can deliver to (RFC 5321 path limits). */
export const MAIL_CONVERSATION_PREVIEW_ADDRESS_MAX_LENGTH = 320;

/** Stored text read per request: enough to find the newest reply above long quoted history. */
const SOURCE_TEXT_MAX_LENGTH = 8_000;
const SOURCE_HTML_MAX_LENGTH = 32_000;
const SOURCE_SUMMARY_MAX_LENGTH = 4_000;

export type ConversationPreviewBodyState = "synced" | "syncing" | "failed";

/** Bodies of messages in `envelope`, `headers`, or `hydrating` are not stored yet. */
const bodyState = (hydrationStatus: string): ConversationPreviewBodyState =>
  hydrationStatus === "body" || hydrationStatus === "complete" ? "synced" : hydrationStatus === "failed" ? "failed" : "syncing";

export type ConversationPreview = {
  conversationId: string;
  /** The stored conversation summary as plain text, or null when none is stored. */
  summary: string | null;
  latestMessage: {
    from: { name: string | null; address: string } | null;
    /** Plain text of the newest message without quoted history, or null when it has none. */
    excerpt: string | null;
    /** Whether the stored body is synchronized, still synchronizing, or failed to synchronize. */
    body: ConversationPreviewBodyState;
  } | null;
  attachments: { count: number; firstName: string | null };
  earlierMessageCount: number;
  assigneeName: string | null;
};

type PreviewRow = {
  id: string;
  summary: string | null;
  assignee_name: string | null;
  message_count: number;
  latest_id: string | null;
  latest_plain_text: string | null;
  latest_html: string | null;
  latest_hydration_status: string | null;
  sender_name: string | null;
  sender_address: string | null;
  attachment_count: number;
  first_attachment_name: string | null;
};

/** Cuts at a word within `maxLength` UTF-16 code units, never between the two halves of a surrogate pair. */
const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  let cut = value.slice(0, maxLength - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const boundary = cut.search(/\s\S*$/u);
  return `${(boundary > maxLength * 0.8 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
};

const QUOTED_LINE = /^\s*>/u;
/** Separators that clients put above forwarded or quoted originals instead of `>` prefixes. */
const HISTORY_SEPARATOR =
  /^\s*(?:-{2,}\s*(?:original message|ursprüngliche nachricht|forwarded message|weitergeleitete nachricht)\s*-*|_{10,})\s*$/iu;
/** A horizontal rule, which HTML clients such as Outlook put above their header block. */
const RULE_LINE = /^\s*[-_=]{10,}\s*$/u;
/** Header lines that clients copy above a quoted or forwarded original, in English and German. */
const HEADER_LINE = /^\s*\*?(?:from|von|sent|gesendet|date|datum|to|an|cc|bcc|subject|betreff|reply-to|antwort an)\s*:/iu;
const FROM_HEADER = /^\s*\*?(?:from|von)\s*:\*?\s*\S/iu;
const DATE_HEADER = /^\s*\*?(?:sent|gesendet|date|datum)\s*:/iu;
/** "On … wrote:" and its translations, which may wrap over a few lines above a quote. */
const ATTRIBUTION = /\b(?:wrote|schrieb|écrit|escribió|scrisse|schreef|skrev)\b|@/iu;

const isBlank = (line: string | undefined) => !line?.trim();

/** An Outlook-style block such as "From: …" followed by "Sent: …" within the next lines. */
const startsHeaderBlock = (lines: string[], index: number) =>
  FROM_HEADER.test(lines[index] ?? "") && lines.slice(index + 1, index + 4).some((line) => DATE_HEADER.test(line));

/**
 * Removes `>` quoted lines and the attribution paragraph right above each
 * quoted block, but keeps the unquoted lines between and after them, so
 * bottom-posted and inline replies keep their own text.
 */
const dropQuotedLines = (lines: string[]): string[] => {
  const kept: string[] = [];
  let quoting = false;
  for (const line of lines) {
    if (QUOTED_LINE.test(line)) {
      if (!quoting) {
        while (kept.length > 0 && isBlank(kept.at(-1))) kept.pop();
        const paragraphStart = kept.findLastIndex((candidate) => isBlank(candidate)) + 1;
        const paragraph = kept.slice(paragraphStart);
        if (paragraph.length <= 3 && paragraph.at(-1)?.trimEnd().endsWith(":") && ATTRIBUTION.test(paragraph.join(" "))) {
          kept.length = paragraphStart;
        }
      }
      quoting = true;
      continue;
    }
    if (quoting && kept.length > 0) kept.push("");
    quoting = false;
    kept.push(line);
  }
  return kept;
};

/** Skips a separator and the header block above a forwarded or quoted original. */
const skipHeaderBlock = (lines: string[]): string[] => {
  let index = HISTORY_SEPARATOR.test(lines[0] ?? "") || RULE_LINE.test(lines[0] ?? "") ? 1 : 0;
  while (index < lines.length && isBlank(lines[index])) index += 1;
  const headerStart = index;
  // Header values may wrap onto indented continuation lines.
  while (index < lines.length && (HEADER_LINE.test(lines[index]!) || (index > headerStart && /^\s+\S/u.test(lines[index]!)))) index += 1;
  return lines.slice(index);
};

/**
 * The message's own text without quoted history. Everything from the first
 * forward or original-message separator, or Outlook-style header block, is
 * history; `>` quoted lines are removed wherever they appear. A forward
 * without text of its own shows the forwarded message instead.
 */
const stripQuotedHistory = (text: string): string => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.findIndex((line, index) => HISTORY_SEPARATOR.test(line) || startsHeaderBlock(lines, index));
  const own = dropQuotedLines(start < 0 ? lines : lines.slice(0, start));
  while (own.length > 0 && (isBlank(own.at(-1)) || RULE_LINE.test(own.at(-1)!))) own.pop();
  if (start < 0 || own.some((line) => !isBlank(line))) return own.join("\n");
  return dropQuotedLines(skipHeaderBlock(lines.slice(start))).join("\n");
};

const HTML_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    // Gmail and Thunderbird history becomes `>` quoted lines below its attribution, which the
    // text rules remove; a Gmail forward keeps its body. Yahoo history is not in a blockquote.
    { selector: "div.yahoo_quoted", format: "skip" },
    { selector: "blockquote", options: { trimEmptyLines: true } },
    { selector: "ul", options: { itemPrefix: "• " } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
  ],
};

const htmlToText = (html: string): string => {
  try {
    return convert(html, HTML_TEXT_OPTIONS);
  } catch {
    return "";
  }
};

/**
 * Plain text of a message for the quick look: the reply without quoted
 * history, line breaks kept, blank lines collapsed, and cut to the budget.
 * HTML is only a fallback for messages without a text version; images and
 * link targets are dropped, so no remote content is referenced.
 */
export const conversationPreviewExcerpt = (plainText: string | null, html: string | null): string | null => {
  const source = plainText?.trim() ? plainText : html ? htmlToText(html) : "";
  const text = stripQuotedHistory(source)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return text ? truncate(text, MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH) : null;
};

/** A stored Markdown summary as one plain-text paragraph within the budget. */
export const conversationPreviewSummary = (summary: string | null): string | null => {
  if (!summary?.trim()) return null;
  const text = htmlToText(markdown.renderSync(summary, { links: "plain" }))
    .replace(/\s+/gu, " ")
    .trim();
  return text ? truncate(text, MAIL_CONVERSATION_PREVIEW_SUMMARY_MAX_LENGTH) : null;
};

/**
 * The facts a quick look card shows for one conversation. Reads only stored
 * projections: the newest message's text columns, attachment rows, and the
 * stored summary. It never hydrates bodies, calls AI, loads remote content, or
 * changes read state. Callers without read access get the same not-found
 * result as for a conversation that does not exist.
 */
export const getConversationPreview = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationPreview>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed.error.code === "FORBIDDEN" ? fail(err.notFound("Conversation")) : allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId);
  if (!visible.ok) return visible;
  const [row] = await sql<PreviewRow[]>`
    SELECT
      c.id,
      LEFT(c.summary, ${SOURCE_SUMMARY_MAX_LENGTH}) AS summary,
      (SELECT string_agg(COALESCE(NULLIF(u.display_name, ''), u.uid), ', ' ORDER BY a.assigned_at, a.user_id)
        FROM mail.conversation_assignees a JOIN auth.users u ON u.id = a.user_id WHERE a.conversation_id = c.id) AS assignee_name,
      (SELECT COUNT(*)::int FROM mail.conversation_messages count_cm WHERE count_cm.conversation_id = c.id) AS message_count,
      latest.id AS latest_id,
      LEFT(latest_body.plain_text, ${SOURCE_TEXT_MAX_LENGTH}) AS latest_plain_text,
      CASE
        WHEN NULLIF(btrim(LEFT(latest_body.plain_text, ${SOURCE_TEXT_MAX_LENGTH})), '') IS NULL
        THEN LEFT(latest_body.sanitized_html, ${SOURCE_HTML_MAX_LENGTH})
      END AS latest_html,
      latest_body.hydration_status AS latest_hydration_status,
      sender.display_name AS sender_name,
      sender.email AS sender_address,
      (
        SELECT COUNT(*)::int
        FROM mail.conversation_messages attachment_cm
        JOIN mail.attachments attachment ON attachment.message_id = attachment_cm.message_id
        WHERE attachment_cm.conversation_id = c.id
      ) AS attachment_count,
      first_attachment.filename AS first_attachment_name
    FROM mail.conversations c
    -- Only the newest message's id here: Postgres evaluates select-list expressions on every
    -- row before the top-1 sort, which would decompress every body of a long conversation.
    LEFT JOIN LATERAL (
      SELECT mc.id
      FROM mail.conversation_messages cm
      JOIN mail.message_contents mc ON mc.id = cm.message_id
      WHERE cm.conversation_id = c.id
        AND NOT ${isUnsentOutboundMessage(sql`mc.id`)}
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN mail.message_contents latest_body ON latest_body.id = latest.id
    LEFT JOIN LATERAL (
      SELECT address.display_name, address.email
      FROM mail.message_addresses address
      WHERE address.message_id = latest.id AND address.role = 'from'
      ORDER BY address.position
      LIMIT 1
    ) sender ON true
    LEFT JOIN LATERAL (
      SELECT attachment.filename
      FROM mail.conversation_messages attachment_cm
      JOIN mail.message_contents attachment_message ON attachment_message.id = attachment_cm.message_id
      JOIN mail.attachments attachment ON attachment.message_id = attachment_cm.message_id
      JOIN mail.message_parts part ON part.id = attachment.part_id
      WHERE attachment_cm.conversation_id = c.id
      ORDER BY attachment_message.internal_date DESC, attachment_message.id DESC, ${attachmentMimeOrder}
      LIMIT 1
    ) first_attachment ON true
    WHERE c.id = ${params.conversationId}::uuid AND c.mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!row) return fail(err.notFound("Conversation"));
  const name = (value: string | null) => (value?.trim() ? truncate(value.trim(), MAIL_CONVERSATION_PREVIEW_NAME_MAX_LENGTH) : null);
  return ok({
    conversationId: row.id,
    summary: conversationPreviewSummary(row.summary),
    latestMessage: row.latest_id
      ? {
          from: row.sender_address
            ? { name: name(row.sender_name), address: truncate(row.sender_address, MAIL_CONVERSATION_PREVIEW_ADDRESS_MAX_LENGTH) }
            : null,
          excerpt: conversationPreviewExcerpt(row.latest_plain_text, row.latest_html),
          body: bodyState(row.latest_hydration_status ?? ""),
        }
      : null,
    attachments: { count: row.attachment_count, firstName: name(row.first_attachment_name) },
    earlierMessageCount: Math.max(0, row.message_count - 1),
    assigneeName: name(row.assignee_name),
  });
};
