import { z } from "zod";
import { CAPABILITY_DISCOVERY_TIMEOUT_MS } from "../_internal/capability-timeout";
import { listCapabilities } from "../_internal/registry";
import { dispatchCapability } from "../api/capabilities";
import {
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
  turns?: { conversationId: string; turnIds: readonly string[] },
): Promise<{ origins: AiMessageOrigin[]; turnShortIds: Map<string, string> }> => {
  // Typed key lookups keep each branch on its primary or unique index.
  const idsOf = (kind: AiStoredMessageOrigin["kind"], uuidOnly: boolean) => [
    ...new Set(origins.flatMap((origin) => (origin.kind === kind && (!uuidOnly || UUID.test(origin.id)) ? [origin.id] : []))),
  ];
  const people = idsOf("person", true);
  const automations = idsOf("automation", true);
  const chats = idsOf("chat", false);
  const turnIds = [...new Set(turns?.turnIds.filter((id) => UUID.test(id)) ?? [])];
  type NameRow = { id: string; name: string; kind: "person" | "automation" | "chat" | "turn"; href: string | null };
  const rows: NameRow[] =
    !people.length && !automations.length && !chats.length && !turnIds.length
      ? []
      : await sql<NameRow[]>`
    SELECT id::text, display_name AS name, 'person' AS kind, NULL::text AS href FROM auth.users WHERE id = ANY(${toPgTextArray(people)}::uuid[])
    UNION ALL
    SELECT id::text, name, 'automation', NULL::text FROM auth.service_accounts WHERE id = ANY(${toPgTextArray(automations)}::uuid[])
    UNION ALL
    SELECT short_id, title, 'chat', CASE WHEN created_by_user_id=${viewer.userId ?? null}::uuid AND archived_at IS NULL
      THEN '/app/assistant?conversation=' || short_id ELSE NULL END FROM ai.conversations WHERE short_id=ANY(${toPgTextArray(chats)}::text[])
    UNION ALL
    SELECT id::text, short_id, 'turn', NULL::text FROM ai.turns
    WHERE conversation_id = ${turns?.conversationId ?? null}::uuid AND id = ANY(${toPgTextArray(turnIds)}::uuid[])
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
      const result = capabilityResultSchema(z.unknown(), { consumer: true }).parse(addCloudResourceHrefs(await response.json(), apps));
      const own = result.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
      const projected = own && LinkedCloudResourceReferenceSchema.parse(own);
      return projected?.title ? { name: projected.title, ...(projected.href ? { href: projected.href } : {}) } : null;
    })().catch(() => null);
    resources.set(key, read);
    return read;
  };
  const projectedOrigins = await Promise.all(
    origins.map(async (origin): Promise<AiMessageOrigin> => {
      if (origin.kind === "wakeup")
        return { kind: "wakeup", id: origin.id, name: aiWakeupMessages(viewer.locale ?? "en").origin, scheduledAt: origin.scheduledAt };
      const row = known.get(`${origin.kind}:${origin.id}`);
      const fallback = origin.kind === "person" ? "Person" : origin.kind === "chat" ? "Chat" : "Automation";
      const resource = origin.kind === "automation" ? await resolveAutomation(origin) : null;
      return {
        kind: origin.kind,
        id: origin.id,
        name: resource?.name ?? row?.name ?? fallback,
        ...(origin.kind !== "person" && (resource?.href ?? row?.href) ? { href: resource?.href ?? row?.href ?? undefined } : {}),
      };
    }),
  );
  return { origins: projectedOrigins, turnShortIds };
};
