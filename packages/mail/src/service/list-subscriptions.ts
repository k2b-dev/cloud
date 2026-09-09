import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type NetworkLookup,
  type PublicNetworkAddress,
  resolvePublicNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { sql } from "bun";
import { z } from "zod";
import {
  type MailingListDispositionInput,
  type MailingListDispositionResult,
  type MailSubscriptionPage,
  type MailSubscriptionSummary,
  mailingListDispositionInputSchema,
  mailingListKeySchema,
  mailSubscriptionPageSchema,
  type UnsubscribeMailingListInput,
  type UnsubscribeMailingListResult,
  unsubscribeMailingListInputSchema,
  unsubscribeMailingListResultSchema,
} from "../contracts";
import type { MailRequestContext } from "./auth";
import { actorRefFromRequest } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { createActorCommands } from "./commands";
import { publishMailMailboxEvent } from "./events";
import { resolveRoleFolder } from "./folders";
import { allowedExternalHref, mailingListMetadata, normalizeListId, oneClickEnabled } from "./mailing-list-metadata";
import { parseMessageProtocolFacts } from "./message-protocol";

export { mailingListMetadata, subscriptionLink } from "./mailing-list-metadata";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DISPOSITION_LIMIT = 500;
const internalMailSubscriptionPageSchema = mailSubscriptionPageSchema.extend({
  items: mailSubscriptionPageSchema.shape.items.element
    .extend({ lastMessageId: z.string().uuid(), lastConversationId: z.string().uuid().nullable() })
    .array(),
});

type SubscriptionCursor = { version: 1; date: string; listKey: string };
type SubscriptionRow = {
  list_key: string;
  message_count: string | number;
  recent_message_count: string | number;
  conversation_count: string | number;
  last_message_at: Date | string;
  last_subject: string;
  last_sender: string | null;
  last_message_id: string;
  last_conversation_id: string | null;
  protocol_facts: unknown;
  subscription_state: "requesting" | "unsubscribe_requested" | "failed" | null;
  requested_at: Date | string | null;
  last_error_code: string | null;
};
type DispositionTarget = {
  remote_message_ref_id: string;
  message_id: string;
  source_folder_id: string;
};
type SubscriptionClaimRow = {
  id: string;
  state: "requesting" | "unsubscribe_requested" | "failed";
  endpoint: string;
  requested_at: Date | string | null;
};

const cursorSchema = z
  .object({
    version: z.literal(1),
    date: z.string().datetime(),
    listKey: z.string().min(1).max(4096),
  })
  .strict();

const encodeCursor = (cursor: SubscriptionCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string | undefined): Result<SubscriptionCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid subscription cursor"));
  } catch {
    return fail(err.badInput("Invalid subscription cursor"));
  }
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const externalFailureCode = (error: unknown): string => {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
  return `ONE_CLICK_${code.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`.slice(0, 200);
};

const listKeySql = sql`
  lower(
    btrim(
      CASE
        WHEN content.protocol_facts #>> '{list,id}' ~ '<[^<>]+>\\s*$'
          THEN regexp_replace(content.protocol_facts #>> '{list,id}', '^.*<([^<>]+)>\\s*$', '\\1')
        ELSE content.protocol_facts #>> '{list,id}'
      END
    )
  )
`;
const listKeyHashSql = sql`md5(${listKeySql})`;

export const listSubscriptions = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  cursor?: string;
  limit?: number;
  focusedListKey?: string;
}): Promise<Result<MailSubscriptionPage>> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const cursor = decodeCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  const focusedListKey = params.focusedListKey?.trim().toLowerCase();

  const rows = await sql<SubscriptionRow[]>`
    WITH messages AS (
      SELECT
        content.id,
        content.id AS message_id,
        content.subject,
        content.internal_date,
        content.protocol_facts,
        ${listKeySql} AS list_key,
        conversation_message.conversation_id,
        sender.display_name,
        sender.email
      FROM mail.message_contents content
      LEFT JOIN mail.conversation_messages conversation_message ON conversation_message.message_id = content.id
      LEFT JOIN LATERAL (
        SELECT address.display_name, address.email
        FROM mail.message_addresses address
        WHERE address.message_id = content.id AND address.role = 'from'
        ORDER BY address.position
        LIMIT 1
      ) sender ON true
      WHERE content.mailbox_id = ${params.mailboxId}::uuid
        AND NULLIF(btrim(content.protocol_facts #>> '{list,id}'), '') IS NOT NULL
    ),
    grouped AS (
      SELECT
        list_key,
        COUNT(*)::int AS message_count,
        COUNT(*) FILTER (WHERE internal_date >= now() - interval '30 days')::int AS recent_message_count,
        COUNT(DISTINCT conversation_id)::int AS conversation_count,
        MAX(internal_date) AS last_message_at,
        (array_agg(subject ORDER BY internal_date DESC, id DESC))[1] AS last_subject,
        (array_agg(COALESCE(NULLIF(display_name, ''), email) ORDER BY internal_date DESC, id DESC))[1] AS last_sender,
        (array_agg(message_id ORDER BY internal_date DESC, id DESC))[1] AS last_message_id,
        (array_agg(conversation_id ORDER BY internal_date DESC, id DESC))[1] AS last_conversation_id,
        (array_agg(protocol_facts ORDER BY internal_date DESC, id DESC))[1] AS protocol_facts
      FROM messages
      WHERE list_key <> ''
      GROUP BY list_key
    )
    SELECT
      grouped.*,
      subscription.state AS subscription_state,
      subscription.requested_at,
      subscription.last_error_code
    FROM grouped
    LEFT JOIN mail.list_subscriptions subscription
     ON subscription.mailbox_id = ${params.mailboxId}::uuid
     AND subscription.list_key = grouped.list_key
    WHERE (
      ${cursor.data?.date ?? null}::timestamptz IS NULL
      OR (grouped.last_message_at, grouped.list_key) < (
        ${cursor.data?.date ?? null}::timestamptz,
        ${cursor.data?.listKey ?? null}::text
      )
    )
    ORDER BY grouped.last_message_at DESC, grouped.list_key DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).flatMap((row): MailSubscriptionSummary[] => {
    const facts = parseMessageProtocolFacts(row.protocol_facts);
    const metadata = mailingListMetadata(facts);
    if (!metadata) return [];
    return [
      {
        listKey: row.list_key,
        name: metadata.name,
        address: metadata.address,
        status: row.subscription_state ?? "active",
        unsubscribe: metadata.unsubscribe,
        postHref: metadata.postHref,
        helpHref: metadata.helpHref,
        archiveHref: metadata.archiveHref,
        messageCount: Number(row.message_count),
        recentMessageCount: Number(row.recent_message_count),
        conversationCount: Number(row.conversation_count),
        lastMessageAt: toIso(row.last_message_at),
        lastSubject: row.last_subject,
        lastSender: row.last_sender,
        lastMessageId: row.last_message_id,
        lastConversationId: row.last_conversation_id,
        unsubscribeRequestedAt: row.requested_at ? toIso(row.requested_at) : null,
        unsubscribeErrorCode: row.last_error_code,
      },
    ];
  });
  const lastRow = rows[Math.min(limit, rows.length) - 1];
  let visibleItems = items;
  if (!params.cursor && focusedListKey && !items.some((item) => item.listKey === focusedListKey)) {
    const focused = await getSubscription(params.context, params.mailboxId, focusedListKey);
    if (!focused.ok) return focused;
    if (focused.data) visibleItems = [focused.data, ...items];
  }
  const value = {
    items: visibleItems,
    nextCursor:
      hasMore && lastRow
        ? encodeCursor({
            version: 1,
            date: toIso(lastRow.last_message_at),
            listKey: lastRow.list_key,
          })
        : null,
  };
  const parsed = internalMailSubscriptionPageSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail(err.internal("Subscription data is invalid"));
};

export const getSubscription = async (
  context: MailRequestContext,
  mailboxId: string,
  listKey: string,
): Promise<Result<MailSubscriptionSummary | null>> => {
  const parsedListKey = mailingListKeySchema.safeParse(listKey);
  if (!parsedListKey.success) return fail(err.badInput("Invalid mailing-list identifier"));
  const canonicalListKey = parsedListKey.data;
  const access = await requireMailboxCollaborationPermission(context, mailboxId, "read");
  if (!access.ok) return access;
  const [row] = await sql<SubscriptionRow[]>`
    WITH messages AS (
      SELECT
        content.id,
        content.id AS message_id,
        content.subject,
        content.internal_date,
        content.protocol_facts,
        conversation_message.conversation_id,
        sender.display_name,
        sender.email
      FROM mail.message_contents content
      LEFT JOIN mail.conversation_messages conversation_message ON conversation_message.message_id = content.id
      LEFT JOIN LATERAL (
        SELECT address.display_name, address.email
        FROM mail.message_addresses address
        WHERE address.message_id = content.id AND address.role = 'from'
        ORDER BY address.position
        LIMIT 1
      ) sender ON true
      WHERE content.mailbox_id = ${mailboxId}::uuid
        AND ${listKeyHashSql} = md5(${canonicalListKey})
        AND ${listKeySql} = ${canonicalListKey}
    )
    SELECT
      ${canonicalListKey}::text AS list_key,
      COUNT(*)::int AS message_count,
      COUNT(*) FILTER (WHERE internal_date >= now() - interval '30 days')::int AS recent_message_count,
      COUNT(DISTINCT conversation_id)::int AS conversation_count,
      MAX(internal_date) AS last_message_at,
      (array_agg(subject ORDER BY internal_date DESC, messages.id DESC))[1] AS last_subject,
      (array_agg(COALESCE(NULLIF(display_name, ''), email) ORDER BY internal_date DESC, messages.id DESC))[1] AS last_sender,
      (array_agg(message_id ORDER BY internal_date DESC, messages.id DESC))[1] AS last_message_id,
      (array_agg(conversation_id ORDER BY internal_date DESC, messages.id DESC))[1] AS last_conversation_id,
      (array_agg(protocol_facts ORDER BY internal_date DESC, messages.id DESC))[1] AS protocol_facts,
      subscription.state AS subscription_state,
      subscription.requested_at,
      subscription.last_error_code
    FROM messages
    LEFT JOIN mail.list_subscriptions subscription
     ON subscription.mailbox_id = ${mailboxId}::uuid
     AND subscription.list_key = ${canonicalListKey}
    GROUP BY subscription.state, subscription.requested_at, subscription.last_error_code
  `;
  if (!row?.last_message_id) return ok(null);
  const facts = parseMessageProtocolFacts(row.protocol_facts);
  const metadata = mailingListMetadata(facts);
  if (!metadata) return ok(null);
  return ok({
    listKey: canonicalListKey,
    name: metadata.name,
    address: metadata.address,
    status: row.subscription_state ?? "active",
    unsubscribe: metadata.unsubscribe,
    postHref: metadata.postHref,
    helpHref: metadata.helpHref,
    archiveHref: metadata.archiveHref,
    messageCount: Number(row.message_count),
    recentMessageCount: Number(row.recent_message_count),
    conversationCount: Number(row.conversation_count),
    lastMessageAt: toIso(row.last_message_at),
    lastSubject: row.last_subject,
    lastSender: row.last_sender,
    lastMessageId: row.last_message_id,
    lastConversationId: row.last_conversation_id,
    unsubscribeRequestedAt: row.requested_at ? toIso(row.requested_at) : null,
    unsubscribeErrorCode: row.last_error_code,
  });
};

type RequestOptions = {
  lookup?: NetworkLookup;
  request?: OneClickTransport;
  timeoutMs?: number;
};

type OneClickResponse = { statusCode: number; location: string | null };
type OneClickTransport = (url: URL, addresses: readonly PublicNetworkAddress[], timeoutMs: number) => Promise<OneClickResponse>;

const performOneClickRequest: OneClickTransport = async (url, addresses, timeoutMs) =>
  await new Promise<OneClickResponse>((resolve, reject) => {
    const body = "List-Unsubscribe=One-Click";
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers: {
          Accept: "text/plain, */*;q=0.1",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "StuVe-Cloud-Mail/1.0",
        },
        lookup(_hostname, _options, callback) {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      },
      (incoming) => {
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            incoming.destroy(Object.assign(new Error("Unsubscribe response is too large"), { code: "RESPONSE_TOO_LARGE" }));
          }
        });
        incoming.on("end", () =>
          resolve({
            statusCode: incoming.statusCode ?? 0,
            location: typeof incoming.headers.location === "string" ? incoming.headers.location : null,
          }),
        );
        incoming.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(Object.assign(new Error("Unsubscribe request timed out"), { code: "REQUEST_TIMEOUT" })),
    );
    request.on("error", reject);
    request.end(body);
  });

const postOneClick = async (href: string, options: RequestOptions = {}, redirectCount = 0): Promise<void> => {
  const url = new URL(href);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("One-click unsubscribe requires a public HTTPS URL");
  const lookup: NetworkLookup = options.lookup ?? ((hostname, lookupOptions) => dnsLookup(hostname, lookupOptions));
  const addresses = await resolvePublicNetworkAddresses(url.hostname, lookup);
  const response = await (options.request ?? performOneClickRequest)(url, addresses, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  if ([307, 308].includes(response.statusCode) && response.location) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error("Unsubscribe endpoint redirected too many times");
    return postOneClick(new URL(response.location, url).toString(), options, redirectCount + 1);
  }
  if (response.statusCode >= 300 && response.statusCode < 400) {
    throw new Error("Unsubscribe endpoint returned an unsafe redirect");
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Unsubscribe endpoint returned HTTP ${response.statusCode}`);
  }
};

export const requestUnsubscribe = async (
  params: {
    context: MailRequestContext;
    mailboxId: string;
    input: UnsubscribeMailingListInput;
  },
  options: RequestOptions = {},
): Promise<Result<UnsubscribeMailingListResult>> => {
  const parsed = unsubscribeMailingListInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid unsubscribe request"));
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write");
  if (!access.ok) return access;
  const current = await getSubscription(params.context, params.mailboxId, parsed.data.listKey);
  if (!current.ok) return current;
  const subscription = current.data;
  if (!subscription?.unsubscribe || subscription.unsubscribe.kind !== "one_click" || subscription.unsubscribe.href !== parsed.data.href) {
    return fail(err.conflict("The advertised one-click unsubscribe link changed. Refresh subscriptions and try again."));
  }
  const actor = actorRefFromRequest(params.context);
  if (actor.kind !== "user" && actor.kind !== "service_account") return fail(err.forbidden("A user-backed actor is required"));
  const actorId = actor.kind === "user" ? actor.userId : actor.serviceAccountId;
  const [claim] = await sql<SubscriptionClaimRow[]>`
    INSERT INTO mail.list_subscriptions (
      mailbox_id, list_key, state, method, endpoint, actor_kind, actor_id
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${parsed.data.listKey},
      'requesting',
      'one_click',
      ${parsed.data.href},
      ${actor.kind},
      ${actorId}::uuid
    )
    ON CONFLICT (mailbox_id, list_key)
    DO UPDATE SET
      state = 'requesting',
      method = EXCLUDED.method,
      endpoint = EXCLUDED.endpoint,
      actor_kind = EXCLUDED.actor_kind,
      actor_id = EXCLUDED.actor_id,
      requested_at = NULL,
      last_error_code = NULL,
      updated_at = now()
    WHERE list_subscriptions.state = 'failed'
       OR list_subscriptions.endpoint <> EXCLUDED.endpoint
       OR (
         list_subscriptions.state = 'requesting'
         AND list_subscriptions.updated_at < now() - interval '15 minutes'
       )
    RETURNING id, state, endpoint, requested_at
  `;
  if (!claim) {
    const [existing] = await sql<SubscriptionClaimRow[]>`
      SELECT id, state, endpoint, requested_at
      FROM mail.list_subscriptions
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND list_key = ${parsed.data.listKey}
    `;
    if (existing?.state === "unsubscribe_requested" && existing.requested_at) {
      return ok({
        listKey: parsed.data.listKey,
        status: "unsubscribe_requested",
        requestedAt: toIso(existing.requested_at),
      });
    }
    return fail(err.conflict("An unsubscribe request is already in progress"));
  }

  try {
    await postOneClick(parsed.data.href, options);
  } catch (error) {
    const errorCode = externalFailureCode(error);
    const activityId = await sql.begin(async (tx) => {
      const [failed] = await tx<{ id: string }[]>`
        UPDATE mail.list_subscriptions
        SET state = 'failed', last_error_code = ${errorCode}, updated_at = now()
        WHERE id = ${claim.id}::uuid AND state = 'requesting' AND endpoint = ${parsed.data.href}
        RETURNING id
      `;
      if (!failed) return null;
      const [activity] = await tx<{ id: string }[]>`
        INSERT INTO mail.activity_events (
          mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${actor.kind},
          ${actorId}::uuid,
          'mailing_list.unsubscribe',
          'failed',
          'list_subscription',
          ${failed.id}::uuid,
          ${{ listKey: parsed.data.listKey, method: "one_click", errorCode }}::jsonb
        )
        RETURNING id
      `;
      return activity?.id ?? null;
    });
    if (activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "subscription",
        targetId: claim.id,
        activityId,
      });
    }
    return fail(err.badInput(error instanceof Error ? error.message : "Unsubscribe request failed"));
  }

  const completed = await sql.begin(async (tx) => {
    const [stored] = await tx<{ id: string; requested_at: Date | string }[]>`
      UPDATE mail.list_subscriptions
      SET
        state = 'unsubscribe_requested',
        requested_at = now(),
        last_error_code = NULL,
        updated_at = now()
      WHERE id = ${claim.id}::uuid AND state = 'requesting' AND endpoint = ${parsed.data.href}
      RETURNING id, requested_at
    `;
    if (!stored) return null;
    const [activity] = await tx<{ id: string }[]>`
      INSERT INTO mail.activity_events (
        mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      ) VALUES (
        ${params.mailboxId}::uuid,
        ${actor.kind},
        ${actorId}::uuid,
        'mailing_list.unsubscribe',
        'confirmed',
        'list_subscription',
        ${stored.id}::uuid,
        ${{ listKey: parsed.data.listKey, method: "one_click" }}::jsonb
      )
      RETURNING id
    `;
    return activity ? { stored, activityId: activity.id } : null;
  });
  if (!completed) return fail(err.conflict("Unsubscribe state changed while the request was running"));
  await publishMailMailboxEvent({
    mailboxId: params.mailboxId,
    conversationId: null,
    reason: "subscription",
    targetId: completed.stored.id,
    activityId: completed.activityId,
  });
  const result = unsubscribeMailingListResultSchema.safeParse({
    listKey: parsed.data.listKey,
    status: "unsubscribe_requested",
    requestedAt: toIso(completed.stored.requested_at),
  });
  return result.success ? ok(result.data) : fail(err.internal("Unsubscribe result is invalid"));
};

export const applyMailingListDisposition = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: MailingListDispositionInput;
}): Promise<Result<MailingListDispositionResult>> => {
  const parsed = mailingListDispositionInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid subscription disposition"));
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write");
  if (!access.ok) return access;
  const destination = await resolveRoleFolder(params.mailboxId, parsed.data.disposition);
  if (!destination.ok) return destination;

  const targets = await sql<DispositionTarget[]>`
    SELECT DISTINCT ON (remote_ref.id)
      remote_ref.id AS remote_message_ref_id,
      content.id AS message_id,
      folder.id AS source_folder_id
    FROM mail.message_contents content
    JOIN mail.remote_message_refs remote_ref ON remote_ref.message_id = content.id AND remote_ref.stale_at IS NULL
    JOIN mail.message_placements placement
      ON placement.remote_message_ref_id = remote_ref.id
     AND placement.deleted_at IS NULL
    JOIN mail.folders folder ON folder.id = placement.folder_id
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    WHERE content.mailbox_id = ${params.mailboxId}::uuid
      AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND ${listKeyHashSql} = md5(${parsed.data.listKey})
      AND ${listKeySql} = ${parsed.data.listKey}
      AND placement.folder_id <> ${destination.data.id}::uuid
    ORDER BY remote_ref.id, placement.updated_at DESC
    LIMIT ${DISPOSITION_LIMIT + 1}
  `;
  const limited = targets.slice(0, DISPOSITION_LIMIT);
  if (limited.length === 0) return ok({ commandCount: 0, truncated: false });
  const commands = await createActorCommands({
    context: params.context,
    mailboxId: params.mailboxId,
    inputs: limited.map((target) => ({
      kind: "move" as const,
      messageId: target.message_id,
      sourceFolderId: target.source_folder_id,
      destinationFolderId: destination.data.id,
      idempotencyKey: `${parsed.data.idempotencyKey}:${target.remote_message_ref_id}`,
      correlationId: parsed.data.idempotencyKey,
    })),
  });
  if (!commands.ok) return commands;
  return ok({ commandCount: commands.data.length, truncated: targets.length > DISPOSITION_LIMIT });
};

export const __test = {
  normalizeListId,
  allowedExternalHref,
  oneClickEnabled,
  postOneClick,
};
