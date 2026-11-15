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

export type AiOriginViewer = { userId?: string | null; authority?: RequestAuthority; locale?: string };

/** One bounded snapshot read, never called from the live event delivery path. */
export const projectAiMessageOrigins = async (
  origins: readonly AiStoredMessageOrigin[],
  viewer: AiOriginViewer,
): Promise<AiMessageOrigin[]> => {
  if (!origins.length) return [];
  const ids = [...new Set(origins.map((origin) => origin.id))];
  const rows = await sql<{ id: string; name: string; kind: "person" | "automation" | "chat"; href: string | null }[]>`
    SELECT id::text, display_name AS name, 'person' AS kind, NULL::text AS href FROM auth.users WHERE id::text = ANY(${toPgTextArray(ids)}::text[])
    UNION ALL
    SELECT id::text, name, 'automation', NULL::text FROM auth.service_accounts WHERE id::text = ANY(${toPgTextArray(ids)}::text[])
    UNION ALL
    SELECT short_id, title, 'chat', CASE WHEN created_by_user_id=${viewer.userId ?? null}::uuid AND archived_at IS NULL
      THEN '/app/assistant?conversation=' || short_id ELSE NULL END FROM ai.conversations WHERE short_id=ANY(${toPgTextArray(ids)}::text[])
  `;
  const known = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  const resources = new Map<string, Promise<{ name: string; href?: string } | null>>();
  const resolveAutomation = (origin: Extract<AiStoredMessageOrigin, { kind: "automation" }>) => {
    if (!origin.resource || !viewer.authority) return Promise.resolve(null);
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
        authority: viewer.authority!,
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
  return Promise.all(
    origins.map(async (origin): Promise<AiMessageOrigin> => {
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
};
