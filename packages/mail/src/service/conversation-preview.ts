import { markdown } from "@k2b/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { convert, type HtmlToTextOptions } from "html-to-text";
import { attachmentMimeOrder } from "./attachment-order";
import type { MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";

/**
 * Text budgets of the quick look card. The card is 22rem x 20rem: the excerpt
 * shows about twelve lines of about sixty characters and the summary three
 * lines, so these limits keep every visible character with headroom for
 * narrow glyphs while bounding the response.
 */
export const MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH = 1_000;
export const MAIL_CONVERSATION_PREVIEW_SUMMARY_MAX_LENGTH = 500;

/** Stored text read per request: enough to find the newest reply above long quoted history. */
const SOURCE_TEXT_MAX_LENGTH = 8_000;
const SOURCE_HTML_MAX_LENGTH = 32_000;
const SOURCE_SUMMARY_MAX_LENGTH = 4_000;

export type ConversationPreview = {
  conversationId: string;
  /** The stored conversation summary as plain text, or null when none is stored. */
  summary: string | null;
  latestMessage: {
    from: { name: string | null; address: string } | null;
    /** Plain text of the newest message without quoted history, or null before its body synchronized. */
    excerpt: string | null;
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
  sender_name: string | null;
  sender_address: string | null;
  attachment_count: number;
  first_attachment_name: string | null;
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength - 1);
  const boundary = cut.search(/\s\S*$/u);
  return `${(boundary > maxLength * 0.8 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
};

const QUOTED_LINE = /^\s*>/u;
/** Separators that clients put above forwarded or quoted originals instead of `>` prefixes. */
const HISTORY_SEPARATOR =
  /^\s*(?:-{2,}\s*(?:original message|ursprüngliche nachricht|forwarded message|weitergeleitete nachricht)\s*-*|_{10,})\s*$/iu;

/** Drops quoted history: the first quoted line, its attribution paragraph, and everything after. */
const stripQuotedHistory = (text: string): string => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const end = lines.findIndex((line) => QUOTED_LINE.test(line) || HISTORY_SEPARATOR.test(line));
  if (end < 0) return text;
  let kept = lines.slice(0, end);
  if (QUOTED_LINE.test(lines[end] ?? "")) {
    // "On … wrote:" may wrap; drop that paragraph when it ends with a colon right above the quote.
    while (kept.length > 0 && !kept.at(-1)?.trim()) kept = kept.slice(0, -1);
    const paragraphStart = kept.findLastIndex((line) => !line.trim()) + 1;
    if (kept.at(-1)?.trimEnd().endsWith(":") && kept.length - paragraphStart <= 3) kept = kept.slice(0, paragraphStart);
  }
  return kept.join("\n");
};

const HTML_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    // Quoted history containers of common clients, including their attribution line.
    { selector: "div.gmail_quote", format: "skip" },
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
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed.error.code === "FORBIDDEN" ? fail(err.notFound("Conversation")) : allowed;
  const [row] = await sql<PreviewRow[]>`
    SELECT
      c.id,
      LEFT(c.summary, ${SOURCE_SUMMARY_MAX_LENGTH}) AS summary,
      CASE WHEN c.assignee_user_id IS NULL THEN NULL ELSE COALESCE(NULLIF(assignee.display_name, ''), assignee.uid) END AS assignee_name,
      (SELECT COUNT(*)::int FROM mail.conversation_messages count_cm WHERE count_cm.conversation_id = c.id) AS message_count,
      latest.id AS latest_id,
      latest.plain_text AS latest_plain_text,
      latest.html AS latest_html,
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
    LEFT JOIN auth.users assignee ON assignee.id = c.assignee_user_id
    LEFT JOIN LATERAL (
      SELECT
        mc.id,
        LEFT(mc.plain_text, ${SOURCE_TEXT_MAX_LENGTH}) AS plain_text,
        CASE WHEN NULLIF(btrim(mc.plain_text), '') IS NULL THEN LEFT(mc.sanitized_html, ${SOURCE_HTML_MAX_LENGTH}) END AS html
      FROM mail.conversation_messages cm
      JOIN mail.message_contents mc ON mc.id = cm.message_id
      WHERE cm.conversation_id = c.id
      ORDER BY mc.internal_date DESC, mc.id DESC
      LIMIT 1
    ) latest ON true
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
  return ok({
    conversationId: row.id,
    summary: conversationPreviewSummary(row.summary),
    latestMessage: row.latest_id
      ? {
          from: row.sender_address ? { name: row.sender_name?.trim() || null, address: row.sender_address } : null,
          excerpt: conversationPreviewExcerpt(row.latest_plain_text, row.latest_html),
        }
      : null,
    attachments: { count: row.attachment_count, firstName: row.first_attachment_name?.trim() || null },
    earlierMessageCount: Math.max(0, row.message_count - 1),
    assigneeName: row.assignee_name,
  });
};
