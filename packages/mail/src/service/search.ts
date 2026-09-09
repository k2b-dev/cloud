import { err, fail, ok, type Result } from "@k2b/stdlib";
import { logger } from "@k2b/cloud/services";
import { escapeLikePattern } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import { z } from "zod";
import type { MailSearchExpression, SearchRequest } from "../contracts";
import { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "./attachment-extraction-contract";
import { type MailRequestContext, userBackedActor } from "./auth";
import { sha256Json } from "./canonical";
import { resolveMailExecution } from "./execution";

type SqlFragment = Bun.SQL.Query<unknown>;
const log = logger("mail:search");

export type MessageSearchHit = {
  id: string;
  conversationId: string | null;
  primaryReference: string | null;
  subject: string;
  participantSummary: string;
  participantLabels: string[];
  latestMessageAt: string;
  messageId: string | null;
  internalDate: string;
  sentAt: string | null;
  from: Array<{ name: string | null; address: string }>;
  to: Array<{ name: string | null; address: string }>;
  flags: string[];
  activeFolderIds: string[];
  flagged: boolean;
  hasAttachments: boolean;
  snippet: string | null;
  attachmentMatch: {
    attachmentId: string;
    messageId: string;
    filename: string | null;
    snippet: string;
    reason: "attachment_content";
  } | null;
  unread: boolean;
  messageCount: number;
  workStatus: "needs_action" | "waiting" | "done" | null;
  assigneeUserId: string | null;
  snoozedUntil: string | null;
  revision: number;
  updatedAt: string;
  sourceFolderId: string | null;
  unreadFolderIds: string[];
  rank: number;
};

export type MessageSearchPage = {
  items: MessageSearchHit[];
  nextCursor: string | null;
  backend: "native" | "pg_textsearch";
};

type DbSearchHit = {
  id: string;
  result_id: string;
  conversation_id: string | null;
  primary_reference: string | null;
  subject: string;
  participant_summary: string;
  participant_labels: unknown[] | string;
  latest_message_at: Date | string;
  sort_date: Date | string;
  message_id: string | null;
  internal_date: Date | string;
  sent_at: Date | string | null;
  from_addresses: unknown[] | string;
  to_addresses: unknown[] | string;
  flags: string[] | null;
  active_folder_ids: unknown[] | string;
  flagged: boolean;
  has_attachments: boolean;
  snippet: string | null;
  attachment_match_id: string | null;
  attachment_match_message_id: string | null;
  attachment_match_filename: string | null;
  attachment_match_snippet: string | null;
  unread: boolean;
  message_count: number;
  work_status: "needs_action" | "waiting" | "done" | null;
  assignee_user_id: string | null;
  snoozed_until: Date | string | null;
  revision: string | number;
  updated_at: Date | string;
  source_folder_id: string | null;
  unread_folder_ids: unknown[] | string;
  rank: number | string;
};

type SearchCursor = {
  version: 3;
  sort: "relevance" | "newest";
  backend: "native" | "pg_textsearch";
  queryHash: string;
  rank: number;
  internalDate: string;
  id: string;
};

const encodeCursor = (cursor: SearchCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string | undefined, sort: SearchCursor["sort"], queryHash: string): Result<SearchCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchCursor>;
    if (
      parsed.version !== 3 ||
      parsed.sort !== sort ||
      (parsed.backend !== "native" && parsed.backend !== "pg_textsearch") ||
      parsed.queryHash !== queryHash ||
      typeof parsed.rank !== "number" ||
      !Number.isFinite(parsed.rank) ||
      typeof parsed.internalDate !== "string" ||
      !Number.isFinite(Date.parse(parsed.internalDate)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      return fail(err.badInput("Invalid search cursor"));
    }
    return ok(parsed as SearchCursor);
  } catch {
    return fail(err.badInput("Invalid search cursor"));
  }
};

export const validateSearchComplexity = (expression: MailSearchExpression): Result<void> => {
  let nodes = 0;
  let queryCharacters = 0;
  let wordCount = 0;
  const visit = (node: MailSearchExpression, depth: number): boolean => {
    nodes += 1;
    if (depth > 8 || nodes > 100) return false;
    if (node.type === "and" || node.type === "or") return node.expressions.every((child) => visit(child, depth + 1));
    if (node.type === "not") return visit(node.expression, depth + 1);
    if (node.type !== "text") return true;
    queryCharacters += node.query.length;
    wordCount += node.query.trim().split(/\s+/u).filter(Boolean).length;
    return queryCharacters <= 5_000 && wordCount <= 500;
  };
  return visit(expression, 1) ? ok() : fail(err.badInput("Search expression is too complex"));
};

const ftsMatch = (document: SqlFragment, query: string, match: "words" | "phrase"): SqlFragment => {
  if (match === "phrase") return sql`${document} @@ phraseto_tsquery('simple', ${query})`;
  return sql`${document} @@ plainto_tsquery('simple', ${query})`;
};

const wordTokens = (query: string): string[] => [...new Set(query.trim().split(/\s+/u).filter(Boolean))];

const bodyChunkMatch = (query: string, match: "words" | "phrase"): SqlFragment => {
  if (match === "phrase") {
    return sql`EXISTS (
      SELECT 1
      FROM mail.message_search_chunks body_chunk
      WHERE body_chunk.message_id = mc.id
        AND body_chunk.mailbox_id = mc.mailbox_id
        AND body_chunk.source_kind = 'body'
        AND body_chunk.search_document @@ phraseto_tsquery('simple', ${query})
    )`;
  }
  const tokens = wordTokens(query).map(
    (token) => sql`EXISTS (
      SELECT 1
      FROM mail.message_search_chunks body_chunk
      WHERE body_chunk.message_id = mc.id
        AND body_chunk.mailbox_id = mc.mailbox_id
        AND body_chunk.source_kind = 'body'
        AND body_chunk.search_document @@ plainto_tsquery('simple', ${token})
    )`,
  );
  return tokens.slice(1).reduce((combined, part) => sql`(${combined} AND ${part})`, tokens[0]!);
};

const attachmentChunksMatch = (attachmentId: SqlFragment, query: string, match: "words" | "phrase"): SqlFragment => {
  if (match === "phrase") {
    return sql`EXISTS (
      SELECT 1
      FROM mail.message_search_chunks attachment_chunk
      WHERE attachment_chunk.attachment_id = ${attachmentId}
        AND attachment_chunk.source_kind = 'attachment'
        AND attachment_chunk.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
        AND attachment_chunk.search_document @@ phraseto_tsquery('simple', ${query})
    )`;
  }
  const tokens = wordTokens(query).map(
    (token) => sql`EXISTS (
      SELECT 1
      FROM mail.message_search_chunks attachment_chunk
      WHERE attachment_chunk.attachment_id = ${attachmentId}
        AND attachment_chunk.source_kind = 'attachment'
        AND attachment_chunk.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
        AND attachment_chunk.search_document @@ plainto_tsquery('simple', ${token})
    )`,
  );
  return tokens.slice(1).reduce((combined, part) => sql`(${combined} AND ${part})`, tokens[0]!);
};

const attachmentWordOrPhraseMatch = (query: string, match: "words" | "phrase"): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.attachments matched_attachment
  WHERE matched_attachment.message_id = mc.id
    AND ${attachmentChunksMatch(sql`matched_attachment.id`, query, match)}
)`;

const attachmentContentMatch = (query: string, match: Extract<MailSearchExpression, { type: "text" }>["match"]): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.attachments attachment_content
  JOIN mail.attachment_extractions extraction
    ON extraction.blob_id = attachment_content.blob_id
   AND extraction.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
   AND extraction.status = 'complete'
  WHERE attachment_content.message_id = mc.id
    AND ${textMatch(sql`extraction.markdown`, query, match)}
)`;

const textMatch = (value: SqlFragment, query: string, match: "words" | "phrase" | "contains" | "exact"): SqlFragment => {
  if (match === "exact") return sql`lower(COALESCE(${value}, '')) = ${query.toLowerCase()}`;
  const tokens = match === "words" ? wordTokens(query) : [query];
  const parts = tokens.map((token) => sql`lower(COALESCE(${value}, '')) LIKE ${`%${escapeLikePattern(token.toLowerCase())}%`} ESCAPE '\\'`);
  return parts.slice(1).reduce((combined, part) => sql`(${combined} AND ${part})`, parts[0]!);
};

const exactAddressMatch = (query: string): SqlFragment => {
  const normalized = query.toLowerCase();
  return query.includes("@")
    ? sql`ma.normalized_email = ${normalized}`
    : sql`(ma.normalized_email = ${normalized} OR lower(COALESCE(ma.display_name, '')) = ${normalized})`;
};

const addressMatch = (
  role: "from" | "to" | "cc" | "bcc" | null,
  query: string,
  match: "words" | "phrase" | "contains" | "exact",
): SqlFragment => {
  const roleClause = role ? sql`ma.role = ${role}` : sql`ma.role IN ('from', 'reply_to', 'to', 'cc', 'bcc')`;
  const valueClause =
    match === "exact" ? exactAddressMatch(query) : textMatch(sql`(ma.email || ' ' || COALESCE(ma.display_name, ''))`, query, match);
  return sql`EXISTS (
    SELECT 1 FROM mail.message_addresses ma
    WHERE ma.message_id = mc.id AND ${roleClause} AND ${valueClause}
  )`;
};

const attachmentNameMatch = (query: string, match: Extract<MailSearchExpression, { type: "text" }>["match"]): SqlFragment => sql`EXISTS (
  SELECT 1 FROM mail.attachments attachment
  WHERE attachment.message_id = mc.id AND ${textMatch(sql`attachment.filename`, query, match)}
)`;

const commentMatch = (
  query: string,
  match: Extract<MailSearchExpression, { type: "text" }>["match"],
  conversationId: SqlFragment,
): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.conversation_comments comment
  WHERE comment.conversation_id = ${conversationId}
    AND comment.deleted_at IS NULL
    AND ${textMatch(sql`comment.body_markdown`, query, match)}
)`;

const folderMatch = (query: string, match: Extract<MailSearchExpression, { type: "text" }>["match"]): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.message_placements folder_placement
  JOIN mail.folders folder ON folder.id = folder_placement.folder_id
  LEFT JOIN mail.binding_folder_refs folder_ref ON folder_ref.folder_id = folder.id
  WHERE folder_placement.message_id = mc.id
    AND folder_placement.deleted_at IS NULL
    AND ${textMatch(sql`(folder.name || ' ' || folder.role || ' ' || COALESCE(folder_ref.remote_path, ''))`, query, match)}
)`;

const tagMatch = (
  query: string,
  match: Extract<MailSearchExpression, { type: "text" }>["match"],
  conversationId: SqlFragment,
): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.conversation_local_tags assignment
  JOIN mail.local_tags tag ON tag.id = assignment.tag_id AND tag.mailbox_id = assignment.mailbox_id
  WHERE assignment.conversation_id = ${conversationId}
    AND ${textMatch(sql`tag.name`, query, match)}
)`;

const keywordMatch = (query: string, match: Extract<MailSearchExpression, { type: "text" }>["match"]): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.message_placements keyword_placement
  CROSS JOIN LATERAL unnest(keyword_placement.keywords) keyword(value)
  WHERE keyword_placement.message_id = mc.id
    AND keyword_placement.deleted_at IS NULL
    AND ${textMatch(sql`keyword.value`, query, match)}
)`;

const referenceMatch = (
  query: string,
  match: Extract<MailSearchExpression, { type: "text" }>["match"],
  conversationId: SqlFragment,
): SqlFragment => sql`EXISTS (
  SELECT 1
  FROM mail.conversation_references reference
  WHERE reference.conversation_id = ${conversationId}
    AND ${match === "exact" ? sql`reference.normalized_value = lower(btrim(${query}))` : textMatch(sql`reference.value`, query, match)}
)`;

const combineOr = (parts: SqlFragment[]): SqlFragment =>
  parts.slice(1).reduce((combined, part) => sql`(${combined} OR ${part})`, parts[0]!);

const compileTextTerm = (term: Extract<MailSearchExpression, { type: "text" }>, conversationId: SqlFragment): SqlFragment => {
  const query = term.query.trim();
  if (term.field === "subject") {
    return term.match === "words" || term.match === "phrase"
      ? ftsMatch(sql`mc.subject_search_document`, query, term.match)
      : textMatch(sql`mc.subject`, query, term.match);
  }
  if (term.field === "body") {
    return term.match === "words" || term.match === "phrase"
      ? bodyChunkMatch(query, term.match)
      : textMatch(sql`mc.plain_text`, query, term.match);
  }
  if (term.field === "from" || term.field === "to" || term.field === "cc" || term.field === "bcc") {
    return addressMatch(term.field, query, term.match);
  }
  if (term.field === "recipients") {
    const recipient =
      term.match === "exact"
        ? exactAddressMatch(query)
        : textMatch(sql`(ma.email || ' ' || COALESCE(ma.display_name, ''))`, query, term.match);
    return sql`EXISTS (
      SELECT 1 FROM mail.message_addresses ma
      WHERE ma.message_id = mc.id AND ma.role IN ('to', 'cc', 'bcc')
        AND ${recipient}
    )`;
  }
  if (term.field === "participants") return addressMatch(null, query, term.match);
  if (term.field === "message_id") return textMatch(sql`mc.message_id`, query, term.match);
  if (term.field === "attachment_name") return attachmentNameMatch(query, term.match);
  if (term.field === "comment") return commentMatch(query, term.match, conversationId);
  if (term.field === "reference") return referenceMatch(query, term.match, conversationId);
  if (term.field === "folder") return folderMatch(query, term.match);
  if (term.field === "tag") return tagMatch(query, term.match, conversationId);
  if (term.field === "keyword") return keywordMatch(query, term.match);

  const body =
    term.match === "words" || term.match === "phrase"
      ? combineOr([bodyChunkMatch(query, term.match), attachmentWordOrPhraseMatch(query, term.match)])
      : textMatch(sql`mc.plain_text`, query, term.match);
  const subject =
    term.match === "words" || term.match === "phrase"
      ? ftsMatch(sql`mc.subject_search_document`, query, term.match)
      : textMatch(sql`mc.subject`, query, term.match);
  const attachmentContent = term.match === "contains" || term.match === "exact" ? [attachmentContentMatch(query, term.match)] : [];
  return combineOr([
    subject,
    body,
    addressMatch(null, query, term.match),
    textMatch(sql`mc.message_id`, query, term.match),
    attachmentNameMatch(query, term.match),
    ...attachmentContent,
    commentMatch(query, term.match, conversationId),
    referenceMatch(query, term.match, conversationId),
    folderMatch(query, term.match),
    tagMatch(query, term.match, conversationId),
    keywordMatch(query, term.match),
  ]);
};

export const compileSearchExpression = (
  expression: MailSearchExpression,
  currentUserId: string | null = null,
  conversationId: SqlFragment = sql`cm.conversation_id`,
): SqlFragment => {
  if (expression.type === "and") {
    const parts = expression.expressions.map((child) => compileSearchExpression(child, currentUserId, conversationId));
    return parts.slice(1).reduce((combined, part) => sql`(${combined} AND ${part})`, parts[0]!);
  }
  if (expression.type === "or") {
    const parts = expression.expressions.map((child) => compileSearchExpression(child, currentUserId, conversationId));
    return parts.slice(1).reduce((combined, part) => sql`(${combined} OR ${part})`, parts[0]!);
  }
  if (expression.type === "not") {
    return sql`NOT (${compileSearchExpression(expression.expression, currentUserId, conversationId)})`;
  }
  if (expression.type === "all") return sql`true`;
  if (expression.type === "folder_id") {
    return sql`EXISTS (
      SELECT 1
      FROM mail.message_placements exact_folder
      WHERE exact_folder.message_id = mc.id
        AND exact_folder.folder_id = ${expression.folderId}::uuid
        AND exact_folder.deleted_at IS NULL
    )`;
  }
  if (expression.type === "local_tag_id") {
    return sql`EXISTS (
      SELECT 1
      FROM mail.conversation_local_tags selected_tag
      WHERE selected_tag.conversation_id = ${conversationId}
        AND selected_tag.tag_id = ${expression.tagId}::uuid
    )`;
  }
  if (expression.type === "assigned_to_me") {
    return sql`${currentUserId}::uuid IS NOT NULL AND EXISTS (
      SELECT 1
      FROM mail.conversations state
      WHERE state.id = ${conversationId} AND state.assignee_user_id = ${currentUserId}::uuid
    )`;
  }
  if (expression.type === "text") return compileTextTerm(expression, conversationId);
  if (expression.type === "date") {
    const field = expression.field === "internal_date" ? sql`mc.internal_date` : sql`mc.sent_at`;
    if (expression.operator === "before") return sql`${field} < ${expression.value}::timestamptz`;
    if (expression.operator === "on_or_before") return sql`${field} <= ${expression.value}::timestamptz`;
    if (expression.operator === "after") return sql`${field} > ${expression.value}::timestamptz`;
    return sql`${field} >= ${expression.value}::timestamptz`;
  }
  if (expression.type === "size") {
    const size = expression.field === "message" ? sql`mc.size_bytes` : sql`attachment_size.size_bytes`;
    const comparison =
      expression.operator === "less_than"
        ? sql`${size} < ${expression.bytes}::bigint`
        : expression.operator === "at_most"
          ? sql`${size} <= ${expression.bytes}::bigint`
          : expression.operator === "equal"
            ? sql`${size} = ${expression.bytes}::bigint`
            : expression.operator === "at_least"
              ? sql`${size} >= ${expression.bytes}::bigint`
              : sql`${size} > ${expression.bytes}::bigint`;
    return expression.field === "message"
      ? comparison
      : sql`EXISTS (
          SELECT 1 FROM mail.attachments attachment_size
          WHERE attachment_size.message_id = mc.id AND ${comparison}
        )`;
  }
  if (expression.type === "work_status") {
    return sql`EXISTS (SELECT 1 FROM mail.conversations state WHERE state.id = ${conversationId} AND state.work_status = ${expression.value})`;
  }
  if (expression.type === "assignee") {
    return expression.userId
      ? sql`EXISTS (
          SELECT 1 FROM mail.conversations state
          WHERE state.id = ${conversationId} AND state.assignee_user_id = ${expression.userId}::uuid
        )`
      : sql`EXISTS (SELECT 1 FROM mail.conversations state WHERE state.id = ${conversationId} AND state.assignee_user_id IS NULL)`;
  }
  return expression.value
    ? sql`EXISTS (
        SELECT 1 FROM mail.conversations state
        WHERE state.id = ${conversationId} AND state.snoozed_until > now()
      )`
    : sql`EXISTS (
        SELECT 1 FROM mail.conversations state
        WHERE state.id = ${conversationId} AND (state.snoozed_until IS NULL OR state.snoozed_until <= now())
      )`;
};

const positiveQueries = (expression: MailSearchExpression, negated = false): string[] => {
  if (expression.type === "and" || expression.type === "or") {
    return expression.expressions.flatMap((child) => positiveQueries(child, negated));
  }
  if (expression.type === "not") return positiveQueries(expression.expression, !negated);
  if (negated || expression.type !== "text" || !["any", "subject", "body"].includes(expression.field)) return [];
  return [expression.query];
};

type AttachmentSearchTerm = Extract<MailSearchExpression, { type: "text" }>;
const positiveAttachmentTerms = (expression: MailSearchExpression, negated = false): AttachmentSearchTerm[] => {
  if (expression.type === "and" || expression.type === "or") {
    return expression.expressions.flatMap((child) => positiveAttachmentTerms(child, negated));
  }
  if (expression.type === "not") return positiveAttachmentTerms(expression.expression, !negated);
  return !negated && expression.type === "text" && expression.field === "any" ? [expression] : [];
};

type FullTextSeed =
  | (Extract<MailSearchExpression, { type: "text" }> & { field: "subject"; match: "words" | "phrase" })
  | (Extract<MailSearchExpression, { type: "text" }> & { field: "body"; match: "phrase" });

type AnyWordsSeed = Extract<MailSearchExpression, { type: "text" }> & { field: "any"; match: "words" };
type IndexedSeed = FullTextSeed | AnyWordsSeed;

const findIndexedSeed = (expression: MailSearchExpression): IndexedSeed | null => {
  if (expression.type === "and") {
    const candidates = expression.expressions.flatMap((child) => {
      const candidate = findIndexedSeed(child);
      return candidate ? [candidate] : [];
    });
    return (
      candidates.find((candidate) => candidate.field === "any") ??
      candidates.find((candidate) => candidate.field === "body") ??
      candidates[0] ??
      null
    );
  }
  if (
    expression.type === "text" &&
    ((expression.field === "any" && expression.match === "words") ||
      (expression.field === "subject" && (expression.match === "words" || expression.match === "phrase")) ||
      (expression.field === "body" && expression.match === "phrase"))
  ) {
    return expression as IndexedSeed;
  }
  return null;
};

const compileAnyWordsSeed = (seed: AnyWordsSeed, mailboxId: string): SqlFragment => {
  const query = seed.query.trim();
  const bodyTokenQueries = wordTokens(query).map(
    (token) => sql`
      SELECT seed_chunk.message_id
      FROM mail.message_search_chunks seed_chunk
      WHERE seed_chunk.mailbox_id = ${mailboxId}::uuid
        AND seed_chunk.source_kind = 'body'
        AND seed_chunk.search_document @@ plainto_tsquery('simple', ${token})
    `,
  );
  const bodySeed = bodyTokenQueries.slice(1).reduce((combined, part) => sql`${combined} INTERSECT ${part}`, bodyTokenQueries[0]!);
  const attachmentTokenQueries = wordTokens(query).map(
    (token) => sql`
      SELECT seed_chunk.message_id, seed_chunk.attachment_id
      FROM mail.message_search_chunks seed_chunk
      WHERE seed_chunk.mailbox_id = ${mailboxId}::uuid
        AND seed_chunk.source_kind = 'attachment'
        AND seed_chunk.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
        AND seed_chunk.search_document @@ plainto_tsquery('simple', ${token})
    `,
  );
  const attachmentSeed = attachmentTokenQueries
    .slice(1)
    .reduce((combined, part) => sql`${combined} INTERSECT ${part}`, attachmentTokenQueries[0]!);
  return sql`
    SELECT seed_message.id AS message_id
    FROM mail.message_contents seed_message
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND ${ftsMatch(sql`seed_message.subject_search_document`, query, "words")}

    UNION

    SELECT seed_body.message_id
    FROM (${bodySeed}) seed_body
    JOIN mail.message_contents seed_message ON seed_message.id = seed_body.message_id
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid

    UNION

    SELECT seed_attachment_body.message_id
    FROM (${attachmentSeed}) seed_attachment_body
    JOIN mail.message_contents seed_message ON seed_message.id = seed_attachment_body.message_id
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid

    UNION

    SELECT seed_address.message_id
    FROM mail.message_addresses seed_address
    JOIN mail.message_contents seed_message ON seed_message.id = seed_address.message_id
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND seed_address.role IN ('from', 'reply_to', 'to', 'cc', 'bcc')
      AND ${textMatch(sql`(seed_address.email || ' ' || COALESCE(seed_address.display_name, ''))`, query, "words")}

    UNION

    SELECT seed_message.id
    FROM mail.message_contents seed_message
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND ${textMatch(sql`seed_message.message_id`, query, "words")}

    UNION

    SELECT seed_attachment.message_id
    FROM mail.attachments seed_attachment
    JOIN mail.message_contents seed_message ON seed_message.id = seed_attachment.message_id
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND ${textMatch(sql`seed_attachment.filename`, query, "words")}

    UNION

    SELECT seed_placement.message_id
    FROM mail.message_placements seed_placement
    JOIN mail.message_contents seed_message ON seed_message.id = seed_placement.message_id
    JOIN mail.folders seed_folder ON seed_folder.id = seed_placement.folder_id
    LEFT JOIN mail.binding_folder_refs seed_folder_ref ON seed_folder_ref.folder_id = seed_folder.id
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND seed_placement.deleted_at IS NULL
      AND ${textMatch(sql`(seed_folder.name || ' ' || seed_folder.role || ' ' || COALESCE(seed_folder_ref.remote_path, ''))`, query, "words")}

    UNION

    SELECT seed_placement.message_id
    FROM mail.message_placements seed_placement
    JOIN mail.message_contents seed_message ON seed_message.id = seed_placement.message_id
    CROSS JOIN LATERAL unnest(seed_placement.keywords) seed_keyword(value)
    WHERE seed_message.mailbox_id = ${mailboxId}::uuid
      AND seed_placement.deleted_at IS NULL
      AND ${textMatch(sql`seed_keyword.value`, query, "words")}

    UNION

    SELECT seed_link.message_id
    FROM mail.conversation_messages seed_link
    JOIN mail.conversations seed_conversation ON seed_conversation.id = seed_link.conversation_id
    JOIN mail.conversation_comments seed_comment ON seed_comment.conversation_id = seed_conversation.id
    WHERE seed_conversation.mailbox_id = ${mailboxId}::uuid
      AND seed_comment.deleted_at IS NULL
      AND ${textMatch(sql`seed_comment.body_markdown`, query, "words")}

    UNION

    SELECT seed_link.message_id
    FROM mail.conversation_messages seed_link
    JOIN mail.conversations seed_conversation ON seed_conversation.id = seed_link.conversation_id
    JOIN mail.conversation_references seed_reference ON seed_reference.conversation_id = seed_conversation.id
    WHERE seed_conversation.mailbox_id = ${mailboxId}::uuid
      AND ${textMatch(sql`seed_reference.value`, query, "words")}

    UNION

    SELECT seed_link.message_id
    FROM mail.conversation_messages seed_link
    JOIN mail.conversations seed_conversation ON seed_conversation.id = seed_link.conversation_id
    JOIN mail.conversation_local_tags seed_assignment ON seed_assignment.conversation_id = seed_conversation.id
    JOIN mail.local_tags seed_tag
      ON seed_tag.id = seed_assignment.tag_id
     AND seed_tag.mailbox_id = seed_assignment.mailbox_id
    WHERE seed_conversation.mailbox_id = ${mailboxId}::uuid
      AND ${textMatch(sql`seed_tag.name`, query, "words")}
  `;
};

const compileIndexedSeed = (seed: IndexedSeed, mailboxId: string): SqlFragment => {
  if (seed.field === "any") return compileAnyWordsSeed(seed, mailboxId);
  if (seed.field === "subject") {
    return sql`
      SELECT seed_message.id AS message_id
      FROM mail.message_contents seed_message
      WHERE seed_message.mailbox_id = ${mailboxId}::uuid
        AND ${ftsMatch(sql`seed_message.subject_search_document`, seed.query.trim(), seed.match)}
    `;
  }
  return sql`
    SELECT DISTINCT seed_chunk.message_id
    FROM mail.message_search_chunks seed_chunk
    WHERE seed_chunk.mailbox_id = ${mailboxId}::uuid
      AND seed_chunk.source_kind = 'body'
      AND seed_chunk.search_document @@ phraseto_tsquery('simple', ${seed.query.trim()})
  `;
};

const isConversationOnlyExpression = (expression: MailSearchExpression): boolean => {
  if (expression.type === "all") return true;
  if (expression.type === "and" || expression.type === "or") {
    return expression.expressions.every(isConversationOnlyExpression);
  }
  if (expression.type === "not") return isConversationOnlyExpression(expression.expression);
  if (
    expression.type === "work_status" ||
    expression.type === "assignee" ||
    expression.type === "snoozed" ||
    expression.type === "assigned_to_me" ||
    expression.type === "local_tag_id"
  ) {
    return true;
  }
  return expression.type === "text" && ["comment", "reference", "tag"].includes(expression.field);
};

const guaranteedFolderIds = (expression: MailSearchExpression): string[] | null => {
  if (expression.type === "folder_id") return [expression.folderId];
  if (expression.type === "not") return null;
  if (expression.type === "and") {
    const ids = expression.expressions.flatMap((child) => guaranteedFolderIds(child) ?? []);
    return ids.length > 0 ? [...new Set(ids)] : null;
  }
  if (expression.type === "or") {
    const scopes = expression.expressions.map(guaranteedFolderIds);
    if (scopes.some((scope) => scope === null)) return null;
    return [...new Set(scopes.flatMap((scope) => scope ?? []))];
  }
  return null;
};

const parseAddressRows = (value: unknown[] | string): Array<{ name: string | null; address: string }> => {
  const rows = typeof value === "string" ? (JSON.parse(value) as unknown[]) : value;
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    return typeof record["address"] === "string"
      ? [{ name: typeof record["name"] === "string" ? record["name"] : null, address: record["address"] }]
      : [];
  });
};

const parseStringRows = (value: unknown[] | string): string[] => {
  const rows = typeof value === "string" ? (JSON.parse(value) as unknown[]) : value;
  return rows.filter((row): row is string => typeof row === "string");
};

const participantLabelsSchema = z.array(z.string().trim().min(1));
const parseParticipantLabels = (value: unknown[] | string): string[] => participantLabelsSchema.parse(parseStringRows(value));

const mapHit = (row: DbSearchHit): MessageSearchHit => ({
  id: row.id,
  conversationId: row.conversation_id,
  primaryReference: row.primary_reference,
  subject: row.subject,
  participantSummary: row.participant_summary,
  participantLabels: parseParticipantLabels(row.participant_labels),
  latestMessageAt: (row.latest_message_at instanceof Date ? row.latest_message_at : new Date(row.latest_message_at)).toISOString(),
  messageId: row.message_id,
  internalDate: (row.internal_date instanceof Date ? row.internal_date : new Date(row.internal_date)).toISOString(),
  sentAt: row.sent_at ? (row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at)).toISOString() : null,
  from: parseAddressRows(row.from_addresses),
  to: parseAddressRows(row.to_addresses),
  flags: row.flags ?? [],
  activeFolderIds: parseStringRows(row.active_folder_ids),
  flagged: row.flagged,
  hasAttachments: row.has_attachments,
  snippet: row.snippet,
  attachmentMatch:
    row.attachment_match_id && row.attachment_match_message_id && row.attachment_match_snippet
      ? {
          attachmentId: row.attachment_match_id,
          messageId: row.attachment_match_message_id,
          filename: row.attachment_match_filename,
          snippet: row.attachment_match_snippet,
          reason: "attachment_content",
        }
      : null,
  unread: row.unread,
  messageCount: row.message_count,
  workStatus: row.work_status,
  assigneeUserId: row.assignee_user_id,
  snoozedUntil: row.snoozed_until
    ? (row.snoozed_until instanceof Date ? row.snoozed_until : new Date(row.snoozed_until)).toISOString()
    : null,
  revision: Number(row.revision),
  updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  sourceFolderId: row.source_folder_id,
  unreadFolderIds: parseStringRows(row.unread_folder_ids),
  rank: Number(row.rank),
});

const detectBackend = async (mailboxId: string): Promise<"native" | "pg_textsearch"> => {
  const [row] = await sql<{ enabled: boolean }[]>`
    SELECT
      m.search_backend <> 'postgres'
      AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch')
      AND EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_am access_method ON access_method.oid = index_class.relam
        JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
        WHERE index_class.oid = to_regclass('mail.message_contents_bm25_idx')
          AND access_method.amname = 'bm25'
          AND index_state.indisvalid
          AND index_state.indisready
          AND index_state.indislive
      ) AS enabled
    FROM mail.mailboxes m
    WHERE m.id = ${mailboxId}::uuid
  `;
  return row?.enabled ? "pg_textsearch" : "native";
};

const runSearch = async (params: {
  db: typeof sql;
  mailboxId: string;
  expression: MailSearchExpression;
  sort: "relevance" | "newest";
  cursor: SearchCursor | null;
  limit: number;
  backend: "native" | "pg_textsearch";
  currentUserId: string | null;
  groupByConversation: boolean;
  excludedFolderIds: readonly string[];
}): Promise<DbSearchHit[]> => {
  const predicate = compileSearchExpression(params.expression, params.currentUserId);
  const indexedSeed = findIndexedSeed(params.expression);
  const indexedSeedCoversExpression = indexedSeed === params.expression;
  const conversationOnly = params.groupByConversation && !indexedSeed && isConversationOnlyExpression(params.expression);
  const cursor = params.cursor;
  const limit = params.limit + 1;
  const includedPlacement = (folderId: SqlFragment) => sql`
    NOT (${folderId} IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${params.excludedFolderIds}::jsonb)
    ))
  `;
  const indexedSeedCte = indexedSeed ? sql`indexed_seed AS MATERIALIZED (${compileIndexedSeed(indexedSeed, params.mailboxId)}),` : sql``;
  const useConversationSeed = conversationOnly;
  const conversationSeedCte = useConversationSeed
    ? sql`
        conversation_seed AS MATERIALIZED (
          SELECT seed_conversation.id
          FROM mail.conversations seed_conversation
          WHERE seed_conversation.mailbox_id = ${params.mailboxId}::uuid
            AND (${compileSearchExpression(params.expression, params.currentUserId, sql`seed_conversation.id`)})
            AND (
              ${cursor?.id ?? null}::uuid IS NULL
              OR (
                seed_conversation.latest_message_at,
                seed_conversation.id
              ) < (
                ${cursor?.internalDate ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid
              )
            )
          ORDER BY seed_conversation.latest_message_at DESC, seed_conversation.id DESC
          LIMIT ${limit}
        ),
      `
    : sql``;
  const messageSource = conversationOnly
    ? sql`
        ${useConversationSeed ? sql`conversation_seed selected_conversation JOIN` : sql``}
        mail.conversations seed_conversation
          ${useConversationSeed ? sql`ON seed_conversation.id = selected_conversation.id` : sql``}
        CROSS JOIN LATERAL (
          SELECT latest_message.*
          FROM mail.conversation_messages latest_link
          JOIN mail.message_contents latest_message ON latest_message.id = latest_link.message_id
          WHERE latest_link.conversation_id = seed_conversation.id
            AND EXISTS (
              SELECT 1
              FROM mail.message_placements latest_visible
              WHERE latest_visible.message_id = latest_message.id
                AND latest_visible.deleted_at IS NULL
                AND ${includedPlacement(sql`latest_visible.folder_id`)}
            )
          ORDER BY latest_message.internal_date DESC, latest_message.id DESC
          LIMIT 1
        ) mc
      `
    : indexedSeed
      ? sql`
          indexed_seed seed
          CROSS JOIN LATERAL (
            SELECT seeded_message.*
            FROM mail.message_contents seeded_message
            WHERE seeded_message.id = seed.message_id
            OFFSET 0
          ) mc
        `
      : sql`mail.message_contents mc`;
  const sourceMailboxPredicate = conversationOnly ? sql`seed_conversation.mailbox_id = ${params.mailboxId}::uuid` : sql`true`;
  const folderIds = guaranteedFolderIds(params.expression);
  const unreadFolderPredicate = folderIds
    ? sql`unread_placement.folder_id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(${folderIds}::jsonb)
      )`
    : sql`true`;
  const queryText = positiveQueries(params.expression).join(" OR ").slice(0, 4_000);
  const attachmentTerms = positiveAttachmentTerms(params.expression);
  const attachmentQueryText = attachmentTerms
    .map((term) => term.query)
    .join(" OR ")
    .slice(0, 4_000);
  const attachmentPredicates = attachmentTerms.map((term) =>
    term.match === "words" || term.match === "phrase"
      ? attachmentChunksMatch(sql`attachment_match_source.id`, term.query, term.match)
      : textMatch(sql`attachment_extraction.markdown`, term.query, term.match),
  );
  const attachmentPredicate = attachmentPredicates.length > 0 ? combineOr(attachmentPredicates) : sql`false`;
  const messageNewestPage =
    !params.groupByConversation && params.sort === "newest"
      ? sql`
          AND (
            ${cursor?.id ?? null}::uuid IS NULL
            OR (mc.internal_date, mc.id) < (${cursor?.internalDate ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
          )
          ORDER BY mc.internal_date DESC, mc.id DESC
          LIMIT ${limit}
        `
      : sql``;
  const rank =
    params.sort === "newest" || !queryText
      ? sql`0::double precision`
      : params.backend === "pg_textsearch"
        ? sql`-((COALESCE(mc.subject, '') || ' ' || COALESCE(mc.subject, '') || ' ' || COALESCE(mc.plain_text, ''))
            <@> to_bm25query(${queryText}, 'mail.message_contents_bm25_idx'))::double precision`
        : sql`(
            2 * ts_rank_cd(mc.subject_search_document, websearch_to_tsquery('simple', ${queryText}))
            + COALESCE((
              SELECT MAX(ts_rank_cd(rank_chunk.search_document, websearch_to_tsquery('simple', ${queryText})))
              FROM mail.message_search_chunks rank_chunk
              WHERE rank_chunk.message_id = mc.id
                AND rank_chunk.mailbox_id = ${params.mailboxId}::uuid
                AND (
                  rank_chunk.source_kind = 'body'
                  OR rank_chunk.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
                )
            ), 0)
          )::double precision`;
  const snippet = queryText
    ? sql`LEFT(ts_headline(
        'simple',
        COALESCE(deduplicated.plain_text, ''),
        websearch_to_tsquery('simple', ${queryText}),
        'StartSel="", StopSel="", MaxWords=36, MinWords=12, MaxFragments=2, FragmentDelimiter= … '
      ), 500)`
    : sql`NULL::text`;
  return params.db<DbSearchHit[]>`
    WITH ${indexedSeedCte}
    ${conversationSeedCte}
    candidate_messages AS MATERIALIZED (
      SELECT
        mc.id,
        CASE WHEN ${params.groupByConversation} THEN COALESCE(cm.conversation_id, mc.id) ELSE mc.id END AS result_id,
        cm.conversation_id,
        mc.subject,
        mc.message_id,
        mc.internal_date,
        mc.sent_at,
        mc.plain_text,
        mc.subject_search_document
      FROM ${messageSource}
      LEFT JOIN mail.conversation_messages cm ON cm.message_id = mc.id
      WHERE ${sourceMailboxPredicate}
        AND mc.mailbox_id = ${params.mailboxId}::uuid
        AND EXISTS (
          SELECT 1 FROM mail.message_placements visible
          WHERE visible.message_id = mc.id
            AND visible.deleted_at IS NULL
            AND ${includedPlacement(sql`visible.folder_id`)}
        )
        AND (${useConversationSeed || indexedSeedCoversExpression ? sql`true` : predicate})
        ${messageNewestPage}
    ),
    matched_messages AS (
      SELECT
        mc.id,
        mc.result_id,
        mc.conversation_id,
        mc.subject,
        mc.message_id,
        mc.internal_date,
        mc.sent_at,
        mc.plain_text,
        COALESCE(from_rows.addresses, '[]'::jsonb) AS from_addresses,
        COALESCE(to_rows.addresses, '[]'::jsonb) AS to_addresses,
        COALESCE(placement.flags, ARRAY[]::text[]) AS flags,
        EXISTS (SELECT 1 FROM mail.attachments attachment WHERE attachment.message_id = mc.id) AS has_attachments,
        ${rank} AS rank
      FROM candidate_messages mc
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
        FROM mail.message_addresses ma
        WHERE ma.message_id = mc.id AND ma.role = 'from'
      ) from_rows ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('name', ma.display_name, 'address', ma.email) ORDER BY ma.position) AS addresses
        FROM mail.message_addresses ma
        WHERE ma.message_id = mc.id AND ma.role = 'to'
      ) to_rows ON true
      LEFT JOIN LATERAL (
        SELECT mp.flags
        FROM mail.message_placements mp
        WHERE mp.message_id = mc.id
          AND mp.deleted_at IS NULL
          AND ${includedPlacement(sql`mp.folder_id`)}
        ORDER BY mp.updated_at DESC
        LIMIT 1
      ) placement ON true
    ),
    ranked_matches AS (
      SELECT
        matched_messages.*,
        row_number() OVER (
          PARTITION BY result_id
          ORDER BY
            CASE WHEN ${params.sort} = 'relevance' THEN rank ELSE 0 END DESC,
            internal_date DESC,
            id DESC
        ) AS match_position
      FROM matched_messages
    ),
    deduplicated AS (
      SELECT *
      FROM ranked_matches
      WHERE match_position = 1
    ),
    page_candidates AS MATERIALIZED (
      SELECT deduplicated.*
      FROM deduplicated
      LEFT JOIN mail.conversations page_conversation
        ON page_conversation.id = deduplicated.conversation_id
      WHERE (
        ${cursor?.id ?? null}::uuid IS NULL
        OR (
          ${params.sort} = 'relevance'
          AND (
            rank < ${cursor?.rank ?? 0}
            OR (
              rank = ${cursor?.rank ?? 0}
              AND (
                CASE WHEN ${params.groupByConversation} THEN COALESCE(page_conversation.latest_message_at, internal_date) ELSE internal_date END,
                result_id
              ) < (${cursor?.internalDate ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
            )
          )
        )
        OR (
          ${params.sort} = 'newest'
          AND (
            CASE WHEN ${params.groupByConversation} THEN COALESCE(page_conversation.latest_message_at, internal_date) ELSE internal_date END,
            result_id
          ) < (${cursor?.internalDate ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
        )
      )
      ORDER BY
        CASE WHEN ${params.sort} = 'relevance' THEN rank ELSE 0 END DESC,
        CASE WHEN ${params.groupByConversation} THEN COALESCE(page_conversation.latest_message_at, internal_date) ELSE internal_date END DESC,
        result_id DESC
      LIMIT ${limit}
    ),
    projected AS (
      SELECT
        deduplicated.id,
        deduplicated.result_id,
        deduplicated.conversation_id,
        primary_reference.value AS primary_reference,
        CASE WHEN ${params.groupByConversation} THEN COALESCE(conversation.subject, deduplicated.subject) ELSE deduplicated.subject END AS subject,
        COALESCE(
          CASE WHEN ${params.groupByConversation} THEN NULLIF(conversation.participant_summary, '') ELSE NULL END,
          deduplicated.from_addresses->0->>'name',
          deduplicated.from_addresses->0->>'address',
          'Unknown sender'
        ) AS participant_summary,
        participant_state.labels AS participant_labels,
        CASE
          WHEN ${params.groupByConversation} THEN COALESCE(conversation.latest_message_at, deduplicated.internal_date)
          ELSE deduplicated.internal_date
        END AS latest_message_at,
        CASE
          WHEN ${params.groupByConversation} THEN COALESCE(conversation.latest_message_at, deduplicated.internal_date)
          ELSE deduplicated.internal_date
        END AS sort_date,
        deduplicated.message_id,
        deduplicated.internal_date,
        deduplicated.sent_at,
        deduplicated.from_addresses,
        deduplicated.to_addresses,
        deduplicated.flags,
        CASE
          WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN message_active_state.folder_ids
          ELSE conversation_active_state.folder_ids
        END AS active_folder_ids,
        CASE
          WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN '\\Flagged' = ANY(deduplicated.flags)
          ELSE EXISTS (
            SELECT 1
            FROM mail.conversation_messages flagged_cm
            JOIN mail.message_placements flagged_placement ON flagged_placement.message_id = flagged_cm.message_id
            WHERE flagged_cm.conversation_id = deduplicated.conversation_id
              AND flagged_placement.deleted_at IS NULL
              AND ${includedPlacement(sql`flagged_placement.folder_id`)}
              AND '\\Flagged' = ANY(flagged_placement.flags)
          )
        END AS flagged,
        CASE
          WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN deduplicated.has_attachments
          ELSE EXISTS (
            SELECT 1
            FROM mail.conversation_messages attachment_cm
            JOIN mail.attachments attachment ON attachment.message_id = attachment_cm.message_id
            WHERE attachment_cm.conversation_id = deduplicated.conversation_id
          )
        END AS has_attachments,
        COALESCE(
          ${snippet},
          NULLIF(
            LEFT(
              CASE
                WHEN ${params.groupByConversation} THEN COALESCE(conversation_latest.plain_text, deduplicated.plain_text)
                ELSE deduplicated.plain_text
              END,
              500
            ),
            ''
          )
        ) AS snippet,
        attachment_match.id AS attachment_match_id,
        attachment_match.message_id AS attachment_match_message_id,
        attachment_match.filename AS attachment_match_filename,
        attachment_match.snippet AS attachment_match_snippet,
        cardinality(
          CASE
            WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN message_unread_state.folder_ids
            ELSE conversation_unread_state.folder_ids
          END
        ) > 0 AS unread,
        CASE
          WHEN deduplicated.conversation_id IS NULL THEN 1
          ELSE (
            SELECT COUNT(*)::int
            FROM mail.conversation_messages count_cm
            WHERE count_cm.conversation_id = deduplicated.conversation_id
          )
        END AS message_count,
        conversation.work_status,
        conversation.assignee_user_id,
        conversation.snoozed_until,
        COALESCE(conversation.revision, 1) AS revision,
        COALESCE(conversation.updated_at, deduplicated.internal_date) AS updated_at,
        CASE
          WHEN ${folderIds?.length === 1 ? folderIds[0] : null}::uuid IS NOT NULL
            THEN ${folderIds?.length === 1 ? folderIds[0] : null}::uuid
          WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN message_active_state.source_folder_id
          ELSE conversation_active_state.source_folder_id
        END AS source_folder_id,
        CASE
          WHEN NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL THEN message_unread_state.folder_ids
          ELSE conversation_unread_state.folder_ids
        END AS unread_folder_ids,
        deduplicated.rank
      FROM page_candidates deduplicated
      LEFT JOIN mail.conversations conversation ON conversation.id = deduplicated.conversation_id
      LEFT JOIN LATERAL (
        SELECT reference.value
        FROM mail.conversation_references reference
        WHERE reference.conversation_id = deduplicated.conversation_id
          AND reference.role = 'primary'
        ORDER BY reference.allocated_at, reference.id
        LIMIT 1
      ) primary_reference ON true
      LEFT JOIN LATERAL (
        SELECT
          attachment_match_source.id,
          attachment_match_source.message_id,
          attachment_match_source.filename,
          LEFT(
            ts_headline(
              'simple',
              attachment_extraction.markdown,
              websearch_to_tsquery('simple', ${attachmentQueryText}),
              'StartSel="", StopSel="", MaxWords=36, MinWords=12, MaxFragments=2, FragmentDelimiter= … '
            ),
            500
          ) AS snippet
        FROM mail.attachments attachment_match_source
        JOIN mail.attachment_extractions attachment_extraction
          ON attachment_extraction.blob_id = attachment_match_source.blob_id
         AND attachment_extraction.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
         AND attachment_extraction.status = 'complete'
        WHERE attachment_match_source.message_id = deduplicated.id
          AND (${attachmentPredicate})
        ORDER BY attachment_match_source.id
        LIMIT 1
      ) attachment_match ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY(
          SELECT DISTINCT unread_placement.folder_id::text
          FROM mail.message_placements unread_placement
          WHERE unread_placement.deleted_at IS NULL
            AND NOT ('\\Seen' = ANY(unread_placement.flags))
            AND deduplicated.conversation_id IS NULL
            AND unread_placement.message_id = deduplicated.id
            AND ${unreadFolderPredicate}
            AND ${includedPlacement(sql`unread_placement.folder_id`)}
          ORDER BY unread_placement.folder_id::text
        ) AS folder_ids
      ) message_unread_state ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY(
          SELECT DISTINCT unread_placement.folder_id::text
          FROM mail.conversation_messages unread_cm
          JOIN mail.message_placements unread_placement
            ON unread_placement.message_id = unread_cm.message_id
           AND unread_placement.deleted_at IS NULL
          WHERE deduplicated.conversation_id IS NOT NULL
            AND unread_cm.conversation_id = deduplicated.conversation_id
            AND NOT ('\\Seen' = ANY(unread_placement.flags))
            AND ${unreadFolderPredicate}
            AND ${includedPlacement(sql`unread_placement.folder_id`)}
          ORDER BY unread_placement.folder_id::text
        ) AS folder_ids
      ) conversation_unread_state ON true
      LEFT JOIN LATERAL (
        SELECT
          ARRAY(
            SELECT DISTINCT active_placement.folder_id::text
            FROM mail.message_placements active_placement
            WHERE active_placement.message_id = deduplicated.id
              AND active_placement.deleted_at IS NULL
              AND ${includedPlacement(sql`active_placement.folder_id`)}
            ORDER BY active_placement.folder_id::text
          ) AS folder_ids,
          CASE
            WHEN COUNT(DISTINCT source_placement.folder_id) = 1 THEN MIN(source_placement.folder_id::text)::uuid
            ELSE NULL
          END AS source_folder_id
        FROM mail.message_placements source_placement
        WHERE (NOT ${params.groupByConversation} OR deduplicated.conversation_id IS NULL)
          AND source_placement.message_id = deduplicated.id
          AND source_placement.deleted_at IS NULL
          AND ${includedPlacement(sql`source_placement.folder_id`)}
      ) message_active_state ON true
      LEFT JOIN LATERAL (
        SELECT
          ARRAY(
            SELECT DISTINCT active_placement.folder_id::text
            FROM mail.conversation_messages active_cm
            JOIN mail.message_placements active_placement
              ON active_placement.message_id = active_cm.message_id
             AND active_placement.deleted_at IS NULL
             AND ${includedPlacement(sql`active_placement.folder_id`)}
            WHERE active_cm.conversation_id = deduplicated.conversation_id
            ORDER BY active_placement.folder_id::text
          ) AS folder_ids,
          CASE
            WHEN COUNT(DISTINCT source_placement.folder_id) = 1 THEN MIN(source_placement.folder_id::text)::uuid
            ELSE NULL
          END AS source_folder_id
        FROM mail.conversation_messages source_cm
        JOIN mail.message_placements source_placement
          ON source_placement.message_id = source_cm.message_id
         AND source_placement.deleted_at IS NULL
         AND ${includedPlacement(sql`source_placement.folder_id`)}
        WHERE deduplicated.conversation_id IS NOT NULL
          AND source_cm.conversation_id = deduplicated.conversation_id
      ) conversation_active_state ON true
      LEFT JOIN LATERAL (
        SELECT latest_message.id, latest_message.plain_text
        FROM mail.conversation_messages latest_cm
        JOIN mail.message_contents latest_message ON latest_message.id = latest_cm.message_id
        WHERE deduplicated.conversation_id IS NOT NULL
          AND latest_cm.conversation_id = deduplicated.conversation_id
          AND EXISTS (
            SELECT 1
            FROM mail.message_placements latest_placement
            WHERE latest_placement.message_id = latest_message.id
              AND latest_placement.deleted_at IS NULL
              AND ${includedPlacement(sql`latest_placement.folder_id`)}
          )
        ORDER BY latest_message.internal_date DESC, latest_message.id DESC
        LIMIT 1
      ) conversation_latest ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN ${params.groupByConversation} THEN COALESCE(conversation_latest.id, deduplicated.id)
            ELSE deduplicated.id
          END AS message_id,
          EXISTS (
            SELECT 1
            FROM mail.message_addresses sender
            JOIN mail.sender_identities identity
              ON identity.mailbox_id = ${params.mailboxId}::uuid
             AND lower(identity.from_address) = sender.normalized_email
            WHERE sender.message_id = COALESCE(conversation_latest.id, deduplicated.id)
              AND sender.role = 'from'
          ) AS outbound
      ) participant_source ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY(
          SELECT participant.label
          FROM (
            SELECT DISTINCT ON (address.normalized_email)
              address.normalized_email,
              COALESCE(NULLIF(address.display_name, ''), address.email) AS label,
              CASE address.role WHEN 'to' THEN 0 WHEN 'cc' THEN 1 WHEN 'bcc' THEN 2 ELSE 3 END AS role_order,
              address.position
            FROM mail.message_addresses address
            WHERE address.message_id = participant_source.message_id
              AND (
                (participant_source.outbound AND address.role IN ('to', 'cc', 'bcc'))
                OR (NOT participant_source.outbound AND address.role = 'from')
              )
            ORDER BY address.normalized_email, role_order, address.position
          ) participant
          ORDER BY participant.role_order, participant.position, participant.normalized_email
        ) AS labels
      ) participant_state ON true
    )
    SELECT *
    FROM projected
    ORDER BY
      CASE WHEN ${params.sort} = 'relevance' THEN rank ELSE 0 END DESC,
      sort_date DESC,
      result_id DESC
  `;
};

const executeSearch = async (params: Omit<Parameters<typeof runSearch>[0], "db">): Promise<DbSearchHit[]> =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '5s'`;
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    await tx`SET LOCAL jit = off`;
    return runSearch({ ...params, db: tx });
  });

const searchErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const searchFailure = (error: unknown): Result<never> => {
  if (searchErrorCode(error) === "57014") return fail(err.badInput("Search query exceeded the execution limit"));
  log.error("Mail search failed", {
    code: searchErrorCode(error),
    error: error instanceof Error ? error.message : String(error),
  });
  return fail(err.internal("Mail search failed"));
};

const executeSearchWithFallback = async (params: {
  mailboxId: string;
  expression: MailSearchExpression;
  sort: SearchCursor["sort"];
  cursor: SearchCursor | null;
  limit: number;
  backend: SearchCursor["backend"];
  currentUserId: string | null;
  groupByConversation: boolean;
  excludedFolderIds: readonly string[];
}): Promise<Result<{ rows: DbSearchHit[]; backend: SearchCursor["backend"] }>> => {
  try {
    const rows = await executeSearch(params);
    return ok({ rows, backend: params.backend });
  } catch (error) {
    const mayFallback = params.backend === "pg_textsearch" && !params.cursor && searchErrorCode(error) !== "57014";
    if (!mayFallback) return searchFailure(error);
  }
  try {
    const rows = await executeSearch({ ...params, cursor: null, backend: "native" });
    return ok({ rows, backend: "native" });
  } catch (error) {
    return searchFailure(error);
  }
};

export const searchMessages = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  request: SearchRequest;
  groupByConversation?: boolean;
  excludedFolderIds?: readonly string[];
}): Promise<Result<MessageSearchPage>> => {
  const expression = params.request.expression;
  const complexity = validateSearchComplexity(expression);
  if (!complexity.ok) return complexity;
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const sort = params.request.sort ?? "relevance";
  const currentUserId = userBackedActor(params.context)?.id ?? null;
  const groupByConversation = params.groupByConversation !== false;
  const excludedFolderIds = [...new Set(params.excludedFolderIds ?? [])].sort();
  const queryHash = sha256Json({ mailboxId: params.mailboxId, expression, currentUserId, groupByConversation, excludedFolderIds });
  const cursor = decodeCursor(params.request.cursor, sort, queryHash);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(params.request.limit ?? 50), 1), 100);
  let backend = sort === "newest" ? ("native" as const) : await detectBackend(params.mailboxId);
  if (cursor.data && cursor.data.backend !== backend) {
    if (cursor.data.backend === "native") backend = "native";
    else return fail(err.badInput("Search ranking changed; restart this search from the first page"));
  }
  const execution = await executeSearchWithFallback({
    mailboxId: params.mailboxId,
    expression,
    sort,
    cursor: cursor.data,
    limit,
    backend,
    currentUserId,
    groupByConversation,
    excludedFolderIds,
  });
  if (!execution.ok) return execution;
  const rows = execution.data.rows;
  backend = execution.data.backend;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapHit);
  const last = items.at(-1);
  const lastRow = pageRows.at(-1);
  return ok({
    items,
    backend,
    nextCursor:
      hasMore && last && lastRow
        ? encodeCursor({
            version: 3,
            sort,
            backend,
            queryHash,
            rank: last.rank,
            internalDate: (lastRow.sort_date instanceof Date ? lastRow.sort_date : new Date(lastRow.sort_date)).toISOString(),
            id: lastRow.result_id,
          })
        : null,
  });
};
