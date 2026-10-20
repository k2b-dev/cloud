import { type AuthContext, expectUserBackedActor, getDateConfig } from "@k2b/cloud/server";
import { get as getSetting } from "@k2b/cloud/services";
import type { ServiceError } from "@k2b/stdlib";
import { sql } from "bun";
import type { Context } from "hono";
import { SHORT_ID_REGEX } from "../../lib/short-id";
import { pulseService } from "../../service";
import { accessScopeFor, requireBaseAccess } from "../../service/access-control";
import { readBasePolicy } from "../../service/base-policy";
import { projectBases, projectSources, resolveBasePublicId, resolvePublicId } from "../../service/public-resources";
import { savedQueries } from "../../service/saved-queries";
import { baseSqlLimits } from "../../service/sql-service";
import { readWorkspacePathState } from "../workspace/routes";
import type { PulseWorkspaceProps } from "../workspace/types";

const publicOrigin = (rawAppUrl: string | null | undefined, requestOrigin: string): string => {
  const raw = String(rawAppUrl ?? "").trim();
  if (!raw) return requestOrigin;
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : raw.startsWith("localhost") || raw.startsWith("127.") || raw.startsWith("[::1]")
      ? `http://${raw}`
      : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return requestOrigin;
  }
};

type PageData = { kind: "error"; status: ServiceError["status"] } | { kind: "ok"; baseName: string; workspaceProps: PulseWorkspaceProps };
export async function loadPulseWorkspacePageData<T extends AuthContext>(c: Context<T>): Promise<PageData> {
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const publicBaseId = c.req.param("baseId") ?? "";
  if (!SHORT_ID_REGEX.test(publicBaseId)) return { kind: "error", status: 404 };
  const baseId = await resolvePublicId("bases", publicBaseId);
  if (!baseId) return { kind: "error", status: 404 };
  const route = readWorkspacePathState(`${url.pathname}${url.search}`, publicBaseId);
  const [base, bases, sources, appUrl] = await Promise.all([
    pulseService.base.get(baseId, user),
    pulseService.base.list(user),
    pulseService.source.list(baseId, user, { signal: c.req.raw.signal }),
    getSetting<string>("app.url").catch(() => ""),
  ]);
  if (!base.ok) return { kind: "error", status: base.error.status };
  if (!sources.ok) return { kind: "error", status: sources.error.status };
  const scope = accessScopeFor(c.get("actor"), c.get("accessSubject"));
  const [write, admin] = scope.ok
    ? await Promise.all([requireBaseAccess(baseId, scope.data, "write"), requireBaseAccess(baseId, scope.data, "admin")])
    : [null, null];
  const [policy, managers] = await Promise.all([
    readBasePolicy(),
    sql<{ name: string }[]>`SELECT COALESCE(u.display_name,sa.name,g.name,'Member') AS name
      FROM pulse.base_access ba JOIN auth.access a ON a.id=ba.access_id
      LEFT JOIN auth.users u ON u.id=a.user_id LEFT JOIN auth.service_accounts sa ON sa.id=a.service_account_id
      LEFT JOIN auth.groups g ON g.id=a.group_id WHERE ba.base_id=${baseId}::uuid AND a.permission='admin'
      ORDER BY a.created_at LIMIT 3`,
  ]);
  const props: PulseWorkspaceProps = {
    initialSettings: { maxRawRetentionDays: policy.maxRawRetentionDays, admins: managers.map((manager) => manager.name) },
    initialPermissions: { write: write?.ok ?? false, admin: admin?.ok ?? false },
    initialBases: await projectBases(bases.ok ? bases.data : [base.data]),
    initialBaseId: publicBaseId,
    initialRouteState: route,
    initialSources: await projectSources(sources.data),
    initialSourceScrapes: {},
    initialSourceApiKeys: {},
    initialQueryCoverage: { bases: bases.ok, baseData: true, sourceDetail: true },
    initialDateConfig: getDateConfig(c),
    initialNow: new Date().toISOString(),
    initialOrigin: publicOrigin(appUrl, url.origin),
  };
  if (route.view === "sql") {
    const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject"), baseId };
    const [limits, query] = await Promise.all([
      baseSqlLimits(identity),
      route.queryId ? savedQueries.get({ ...identity, queryId: route.queryId }) : Promise.resolve(null),
    ]);
    if (query && !query.ok) return { kind: "error", status: query.error.status };
    props.initialSql = {
      limits: limits.ok ? limits.data : null,
      query: query?.ok ? query.data : null,
      error: limits.ok ? null : { code: limits.error.code, details: { ...limits.error } },
    };
  }
  if (route.sourceId) {
    const sourceId = await resolveBasePublicId("sources", baseId, route.sourceId);
    const source = sources.data.find((source) => source.id === sourceId);
    if (!source) return { kind: "error", status: 404 };
    const [scrapes, keys] = await Promise.all([
      pulseService.source.scrapes({ baseId, sourceId: source.id, user }),
      source.kind === "http_ingest"
        ? pulseService.source.apiKeys.list({ baseId, sourceId: source.id, user })
        : Promise.resolve({ ok: true as const, data: [] }),
    ]);
    props.initialSourceScrapes[route.sourceId] = scrapes.ok ? scrapes.data : [];
    props.initialSourceApiKeys[route.sourceId] = keys.ok ? keys.data : [];
    props.initialQueryCoverage.sourceDetail = scrapes.ok && keys.ok;
  }
  return { kind: "ok", baseName: base.data.name, workspaceProps: props };
}
