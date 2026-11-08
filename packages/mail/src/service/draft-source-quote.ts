import type { sql } from "@k2b/cloud";
import { fail, ok, type Result } from "@k2b/stdlib";
import { convert } from "html-to-text";
import { quoteReplyBody } from "../compose-quotation";
import type { MailAddress } from "../contracts";
import { type MailboxAccess, messageVisibleTo } from "./access";
import { composeRenderFailure } from "./compose-render-errors";

/** Read-only source text; missing and invisible sources both produce no quote. */
export const loadDraftSourceQuote = async (params: {
  db: typeof sql;
  mailboxId: string;
  sourceMessageId: string | null | undefined;
  access: MailboxAccess | null;
}): Promise<Result<string | null>> => {
  if (!params.sourceMessageId || !params.access) return ok(null);
  const [source] = await params.db<
    {
      internal_date: Date | string;
      too_large: boolean;
      subject: string;
      plain_text: string | null;
      sanitized_html: string | null;
      from_addresses: MailAddress[];
    }[]
  >`
    SELECT source.internal_date, source.subject,
      (octet_length(source.plain_text) > 2097152 OR (NULLIF(btrim(source.plain_text), '') IS NULL AND octet_length(source.sanitized_html) > 2097152)) AS too_large,
      left(source.plain_text, 2097153) AS plain_text,
      left(source.sanitized_html, 2097153) AS sanitized_html,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a.display_name, 'address', a.email) ORDER BY a.position)
        FROM mail.message_addresses a WHERE a.message_id = source.id AND a.role = 'from'), '[]'::jsonb) AS from_addresses
    FROM mail.message_contents source
    WHERE source.id = ${params.sourceMessageId}::uuid
      AND source.mailbox_id = ${params.mailboxId}::uuid
      AND ${messageVisibleTo(params.access, params.db`source.id`)}
  `;
  if (!source) return ok(null);
  if (source.too_large) return fail(composeRenderFailure("tooLarge"));
  try {
    const text = source.plain_text?.trim()
      ? source.plain_text
      : source.sanitized_html
        ? convert(source.sanitized_html, {
            wordwrap: false,
            selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
          })
        : "";
    if (!text) return ok(null);
    return ok(
      quoteReplyBody(
        {
          from: source.from_addresses,
          to: [],
          subject: source.subject,
          plainText: text,
          internalDate: new Date(source.internal_date).toISOString(),
        },
        text,
        { locale: "en", timeZone: "UTC" },
      ).trimEnd(),
    );
  } catch {
    return fail(composeRenderFailure("conversionFailed"));
  }
};
