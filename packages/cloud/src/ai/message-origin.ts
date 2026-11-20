import { z } from "zod";
import { CAPABILITY_DISCOVERY_TIMEOUT_MS } from "../_internal/capability-timeout";
import { listCapabilities } from "../_internal/registry";
import { dispatchCapability } from "../api/capabilities";
import {
  type CapabilityResult,
  CloudResourceReaderViewSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  LinkedCloudResourceReferenceSchema,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server";
import { toPgTextArray } from "../services/postgres";
import type { AiMessageOrigin, AiStoredMessageOrigin } from "./queue-contracts";
import { addCloudResourceHrefs } from "./resource-refs";
import { aiWakeupMessages } from "./wakeup-messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AiOriginViewer = { userId?: string | null; authority?: RequestAuthority | null; locale?: string };

/**
 * A reader's answer names its resource: the result's own reference with its title, or the canonical reader view
 * (`{ view: { title } }`) with its `open` link. Anything else names nothing.
 */
export const readerResourceName = (
  result: CapabilityResult<unknown>,
  ref: { type: string; id: string },
): { name: string; href?: string } | null => {
  const own = result.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
  const projected = own && LinkedCloudResourceReferenceSchema.parse(own);
  if (projected?.title) return { name: projected.title, ...(projected.href ? { href: projected.href } : {}) };
  const view = ReaderViewResultSchema.safeParse(result.data);
  if (!view.success) return null;
  const href = result.links?.find((link) => link.rel === "open")?.href;
  return { name: view.data.view.title, ...(href ? { href } : {}) };
};
const ReaderViewResultSchema = z.object({ view: CloudResourceReaderViewSchema });

/**
 * One origin as its viewer reads it: the automation's own reader decides its name and link, then the stored name;
 * without either, an automation says only that it is one (`named: false`), so no surface shows "Automation" as a name.
 */
export const projectAiMessageOrigin = (
  origin: AiStoredMessageOrigin,
  row: { name: string; href: string | null } | undefined,
  resource: { name: string; href?: string } | null,
  locale = "en",
): AiMessageOrigin => {
  if (origin.kind === "wakeup")
    return { kind: "wakeup", id: origin.id, name: aiWakeupMessages(locale).origin, scheduledAt: origin.scheduledAt };
  const name = resource?.name ?? row?.name;
  const href = origin.kind === "person" ? undefined : (resource?.href ?? row?.href ?? undefined);
  if (origin.kind === "automation")
    return {
      kind: "automation",
      id: origin.id,
      name: name ?? "Automation",
      ...(href ? { href } : {}),
      ...(name ? {} : { named: false as const }),
    };
  if (origin.kind === "person") return { kind: "person", id: origin.id, name: name ?? "Person" };
  return { kind: "chat", id: origin.id, name: name ?? "Chat", ...(href ? { href } : {}) };
};

/** Origins of a message snapshot, projected for one viewer. */
export const projectAiMessageOrigins = async (
  origins: readonly AiStoredMessageOrigin[],
  viewer: AiOriginViewer,
): Promise<AiMessageOrigin[]> => (await loadAiMessageOrigins(origins, viewer)).origins;

/**
 * One bounded snapshot read, never called from the live event delivery path. The
 * turn short IDs of the same snapshot ride along, so attribution adds no statement.
 */
export const loadAiMessageOrigins = async (
  origins: readonly AiStoredMessageOrigin[],
  viewer: AiOriginViewer,
  turns?: {
    conversationId: string;
    turnIds: readonly string[];
    doneMessages?: readonly { id: string; conversationId: string; turnId: string | null; messageSeq: number | null }[];
  },
): Promise<{
  origins: AiMessageOrigin[];
  turnShortIds: Map<string, string>;
  doneChats: Map<string, { name: string; href: string; messageSeq: number | null; summary: string | null }>;
}> => {
  // Typed key lookups keep each branch on its primary or unique index.
  const idsOf = (kind: AiStoredMessageOrigin["kind"], uuidOnly: boolean) => [
    ...new Set(origins.flatMap((origin) => (origin.kind === kind && (!uuidOnly || UUID.test(origin.id)) ? [origin.id] : []))),
  ];
  const people = idsOf("person", true);
  const automations = idsOf("automation", true);
  const chats = idsOf("chat", false);
  const turnIds = [...new Set(turns?.turnIds.filter((id) => UUID.test(id)) ?? [])];
  const doneMessages = turns?.doneMessages?.filter((message) => UUID.test(message.conversationId)) ?? [];
  type NameRow = {
    id: string;
    name: string;
    kind: "person" | "automation" | "chat" | "turn" | "done";
    href: string | null;
    message_seq: number | null;
    summary: string | null;
  };
  const rows: NameRow[] =
    !people.length && !automations.length && !chats.length && !turnIds.length && !doneMessages.length
      ? []
      : await sql<NameRow[]>`
    SELECT id::text, display_name AS name, 'person' AS kind, NULL::text AS href, NULL::int AS message_seq, NULL::text AS summary FROM auth.users WHERE id = ANY(${toPgTextArray(people)}::uuid[])
    UNION ALL
    SELECT id::text, name, 'automation', NULL::text, NULL::int, NULL::text FROM auth.service_accounts WHERE id = ANY(${toPgTextArray(automations)}::uuid[])
    UNION ALL
    SELECT short_id, title, 'chat', CASE WHEN created_by_user_id=${viewer.userId ?? null}::uuid AND archived_at IS NULL
      THEN '/app/assistant?conversation=' || short_id ELSE NULL END, NULL::int, NULL::text FROM ai.conversations WHERE short_id=ANY(${toPgTextArray(chats)}::text[])
    UNION ALL
    SELECT id::text, short_id, 'turn', NULL::text, NULL::int, NULL::text FROM ai.turns
    WHERE conversation_id = ${turns?.conversationId ?? null}::uuid AND id = ANY(${toPgTextArray(turnIds)}::uuid[])
    UNION ALL
    SELECT requested.id, target.title, 'done', '/app/assistant?conversation=' || target.short_id,
      answer.seq, CASE WHEN answer.role='assistant' THEN left(split_part(trim(answer.search_text), E'\n', 1), 320) ELSE NULL END
    FROM jsonb_to_recordset(${JSON.stringify(doneMessages)}::text::jsonb)
      AS requested(id text,"conversationId" uuid,"turnId" text,"messageSeq" int)
    JOIN ai.conversations target ON target.id=requested."conversationId"
      AND target.created_by_user_id=${viewer.userId ?? null}::uuid AND target.archived_at IS NULL
    LEFT JOIN ai.turns target_turn ON target_turn.conversation_id=target.id AND target_turn.short_id=requested."turnId"
    LEFT JOIN ai.messages answer ON answer.conversation_id=target.id AND answer.seq=requested."messageSeq"
      AND answer.loop_id=target_turn.id::text
  `;
  const turnShortIds = new Map(rows.flatMap((row) => (row.kind === "turn" ? [[row.id, row.name] as const] : [])));
  const known = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  const resources = new Map<string, Promise<{ name: string; href?: string } | null>>();
  const resolveAutomation = (origin: Extract<AiStoredMessageOrigin, { kind: "automation" }>) => {
    const authority = viewer.authority;
    if (!origin.resource || !authority) return Promise.resolve(null);
    const ref = origin.resource;
    const key = `${ref.type}:${ref.id}`;
    const cached = resources.get(key);
    if (cached) return cached;
    const read = (async () => {
      const apps = await listCapabilities();
      const app = apps.find((entry) => entry.appId === cloudResourceRefAppId(ref));
      const reader = app && resolveCapabilityResourceReader(app.manifest, ref);
      if (!app || !reader) return null;
      const response = await dispatchCapability({
        request: new Request("http://localhost/api/ai/queue/origin", {
          method: "POST",
          signal: AbortSignal.timeout(CAPABILITY_DISCOVERY_TIMEOUT_MS),
        }),
        kind: "queries",
        origin: "assistant",
        appId: app.appId,
        capabilityId: reader.localId,
        input: { id: ref.id },
        authority,
        locale: viewer.locale ?? "en",
      });
      if (!response.ok) return null;
      return readerResourceName(
        capabilityResultSchema(z.unknown(), { consumer: true }).parse(addCloudResourceHrefs(await response.json(), apps)),
        ref,
      );
    })().catch(() => null);
    resources.set(key, read);
    return read;
  };
  const projectedOrigins = await Promise.all(
    origins.map(async (origin) =>
      projectAiMessageOrigin(
        origin,
        known.get(`${origin.kind}:${origin.id}`),
        origin.kind === "automation" ? await resolveAutomation(origin) : null,
        viewer.locale ?? "en",
      ),
    ),
  );
  const doneChats = new Map(
    rows.flatMap((row) =>
      row.kind === "done" && row.href
        ? [[row.id, { name: row.name, href: row.href, messageSeq: row.message_seq, summary: row.summary }] as const]
        : [],
    ),
  );
  return { origins: projectedOrigins, turnShortIds, doneChats };
};
