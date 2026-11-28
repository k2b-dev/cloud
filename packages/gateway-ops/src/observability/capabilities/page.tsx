/**
 * Capability execution console on v2.
 *
 * One history for every surface that can call a capability – the assistant, MCP, HTTP and app-to-app mandates – so an
 * operator answers "what did an agent do, on whose behalf, and did it work" in one place. The page is read only: the
 * dispatcher owns every row.
 */
import { listApps } from "@k2b/cloud";
import {
  type CapabilityExecution,
  type CapabilityExecutionGroup,
  type CapabilityExecutionSummary,
  listCapabilityExecutions,
  summarizeCapabilityExecutions,
} from "@k2b/cloud/capabilities/store";
import { type AuthContext, getDateConfig, getLocale, resolveDisplayNames } from "@k2b/cloud/server";
import { aiUsageHref, formatDateTime, formatDurationMs, principalLabel } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { observabilityAdminNav } from "../_components/admin-nav";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import CapabilitiesScreen from "./_components/CapabilitiesScreen.island";
import { executionDetail } from "./detail";
import { statusLabel } from "./labels";
import { capabilityOpsMessages } from "./ops-messages";
import { ORIGIN_ICON, SLOW_DURATION_MS } from "./presentation";
import { capabilitiesQuery, EXECUTIONS_PER_PAGE, executionFilter, parseCapabilitiesAddress, windowStart } from "./query";

const EMPTY_SUMMARY: CapabilityExecutionSummary = {
  executions: 0,
  failed: 0,
  denied: 0,
  destructive: 0,
  avgDurationMs: null,
  p95DurationMs: null,
  apps: [],
  capabilities: [],
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = capabilityOpsMessages.resolve([locale]);
  const params = new URL(c.req.url).searchParams;
  const number = (value: number) => value.toLocaleString(locale);
  const duration = (value: number | null) => (value === null ? "—" : formatDurationMs(Math.round(value), { locale }));
  // The window and its scope come first: the filter offers the apps and capabilities called in it.
  const bare = parseCapabilitiesAddress(
    capabilitiesQuery(locale, undefined, { app: params.get("app"), capability: params.get("capability") }),
    params,
  );
  const now = Date.now();

  let failure: string | null = null;
  let scope = EMPTY_SUMMARY;
  let summary = EMPTY_SUMMARY;
  let executions: CapabilityExecution[] = [];
  let nextCursor: string | null = null;
  let detail: CapabilityExecution[] = [];
  const userNames = new Map<string, string | undefined>();
  const [registered, attention] = await Promise.all([listApps().catch(() => []), readAttention()]);
  try {
    const [scopeResult, summaryResult, page, detailPage] = await Promise.all([
      summarizeCapabilityExecutions({ since: windowStart(bare.state, now) }),
      summarizeCapabilityExecutions(executionFilter(bare.state, now)),
      listCapabilityExecutions({
        ...executionFilter(bare.state, now),
        limit: EXECUTIONS_PER_PAGE,
        ...(bare.cursor ? { cursor: bare.cursor } : {}),
      }),
      bare.request ? listCapabilityExecutions({ requestId: bare.request, limit: 50 }) : Promise.resolve({ items: [] }),
    ]);
    scope = scopeResult;
    summary = summaryResult;
    executions = page.items;
    nextCursor = page.nextCursor ?? null;
    detail = detailPage.items;
    // An execution's userId is the person or the delegating user; a service account is the actor.
    const userIds = [
      ...new Set([
        ...executions.flatMap((row) => (row.userId ? [row.userId] : [])),
        ...(bare.state.filters.user ? [bare.state.filters.user] : []),
      ]),
    ];
    const users = await resolveDisplayNames(userIds.map((userId) => ({ principal: { type: "user" as const, userId } })));
    for (const entry of users) userNames.set(entry.principal.userId, entry.displayName);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const userLabel = (userId: string) => principalLabel({ principal: { type: "user", userId }, displayName: userNames.get(userId) }, locale);
  const appOf = (id: string) => {
    const app = registered.find((candidate) => candidate.id === id);
    return { id, label: app?.name || id, icon: app?.icon?.replace(/^ti\s+(ti-)?/, "") || "apps" };
  };
  const originLabel = { assistant: t.originAssistant, mcp: t.originMcp, http: t.originHttp, app: t.originApp, choice: t.originChoice };
  const group = (row: CapabilityExecutionGroup, kind: "app" | "capability") => ({
    id: row.id,
    label: kind === "app" ? appOf(row.id).label : row.id,
    icon: kind === "app" ? appOf(row.id).icon : "plug",
    executions: number(row.executions),
    failed: row.failed,
    denied: row.denied,
    destructive: row.destructive,
  });
  const user = bare.state.filters.user;

  const cells: KeyCell[] = [
    { icon: "plug", label: t.executions, value: number(summary.executions), meta: `${t.avgDuration}: ${duration(summary.avgDurationMs)}` },
    {
      icon: "alert-circle",
      label: t.failed,
      value: number(summary.failed),
      meta: t.failedSub,
      tone: summary.failed > 0 ? "bad" : undefined,
    },
    {
      icon: "ban",
      label: t.denied,
      value: number(summary.denied),
      meta: `${t.destructive}: ${number(summary.destructive)}`,
      tone: summary.denied > 0 ? "warn" : undefined,
    },
    {
      icon: "hourglass",
      label: t.p95Duration,
      value: duration(summary.p95DurationMs),
      meta: t.inSelectedRange,
      tone: (summary.p95DurationMs ?? 0) > SLOW_DURATION_MS ? "warn" : undefined,
    },
  ];

  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).capabilities}>
      <CapabilitiesScreen
        nav={observabilityAdminNav(c, locale, attention, "capabilities")}
        state={bare.state}
        tab={bare.tab}
        scope={{ apps: scope.apps.map((row) => row.id), capabilities: scope.capabilities.map((row) => row.id) }}
        names={user ? { user: [{ value: user, label: userLabel(user) }] } : undefined}
        lead={t.callCount({ count: summary.executions })}
        ignored={bare.issues.length > 0 ? bare.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null}
        failure={failure}
        cells={cells}
        rows={executions.map((row) => ({
          id: row.id,
          requestId: row.requestId,
          app: appOf(row.appId),
          capability: row.capability,
          origin: { label: originLabel[row.origin], icon: ORIGIN_ICON[row.origin].replace(/^ti\s+(ti-)?/, "") },
          status: row.status,
          statusLabel: statusLabel(row.status, t),
          destructive: row.destructive,
          kind: row.kind === "action" ? t.kindAction : t.kindQuery,
          duration: formatDurationMs(row.durationMs, { locale }),
          slow: row.durationMs > SLOW_DURATION_MS,
          started: formatDateTime(row.startedAt, dateConfig),
          user: row.userId ? { id: row.userId, label: userLabel(row.userId) } : null,
        }))}
        groups={{
          apps: summary.apps.map((row) => group(row, "app")),
          capabilities: summary.capabilities.map((row) => group(row, "capability")),
        }}
        cursor={bare.cursor}
        nextCursor={nextCursor}
        request={bare.request}
        detail={bare.request && detail.length > 0 ? executionDetail(detail, locale, dateConfig) : null}
        user={user ? { label: userLabel(user), aiUsageHref: aiUsageHref({ view: "runs", userId: user }) } : null}
      />
    </AdminLayout>
  );
});
