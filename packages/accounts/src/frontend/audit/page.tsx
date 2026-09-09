import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, type DataTableColumn, Pagination, Paper, Placeholder, StatusBadge, type StatusTone, Tag } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import {
  type AuditActionGroup,
  type AuditEvent,
  type AuditOutcome,
  accountsAppService as accountsService,
  audit,
} from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import AuditFilters from "./AuditFilters.island";
import { actionLabel } from "./audit-labels";

type AuditState = {
  search: string;
  actor: string;
  target: string;
  action: string;
  actionGroup: "" | AuditActionGroup;
  serviceAccountId: string;
  outcome: "" | AuditOutcome;
  provider: "" | "local" | "ipa";
  days: number;
  page: number;
};

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const parseDays = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "30", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3650) : 30;
};

const parseOutcome = (value: string | undefined): AuditState["outcome"] =>
  value === "allowed" || value === "denied" || value === "failed" ? value : "";

const parseProvider = (value: string | undefined): AuditState["provider"] => (value === "local" || value === "ipa" ? value : "");
const parseActionGroup = (value: string | undefined): AuditState["actionGroup"] => (value === "service_accounts" ? value : "");

const buildAuditUrl = (state: Partial<AuditState> = {}): string => {
  const params = new URLSearchParams();
  const merged: AuditState = {
    search: "",
    actor: "",
    target: "",
    action: "",
    actionGroup: "",
    serviceAccountId: "",
    outcome: "",
    provider: "",
    days: 30,
    page: 1,
    ...state,
  };
  if (merged.search.trim()) params.set("search", merged.search.trim());
  if (merged.actor.trim()) params.set("actor", merged.actor.trim());
  if (merged.target.trim()) params.set("target", merged.target.trim());
  if (merged.action.trim()) params.set("action", merged.action.trim());
  if (merged.actionGroup) params.set("actionGroup", merged.actionGroup);
  if (merged.serviceAccountId.trim()) params.set("serviceAccountId", merged.serviceAccountId.trim());
  if (merged.outcome) params.set("outcome", merged.outcome);
  if (merged.provider) params.set("provider", merged.provider);
  if (merged.days !== 30) params.set("days", String(merged.days));
  if (merged.page > 1) params.set("page", String(merged.page));
  const query = params.toString();
  return query ? `/app/accounts/audit?${query}` : "/app/accounts/audit";
};

const statusTone = (outcome: AuditOutcome): StatusTone => {
  if (outcome === "allowed") return "ok";
  if (outcome === "denied") return "warning";
  return "error";
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const state: AuditState = {
    search: (c.req.query("search") ?? "").trim(),
    actor: (c.req.query("actor") ?? "").trim(),
    target: (c.req.query("target") ?? "").trim(),
    action: (c.req.query("action") ?? "").trim(),
    actionGroup: parseActionGroup(c.req.query("actionGroup")),
    serviceAccountId: (c.req.query("serviceAccountId") ?? "").trim(),
    outcome: parseOutcome(c.req.query("outcome")),
    provider: parseProvider(c.req.query("provider")),
    days: parseDays(c.req.query("days")),
    page: parsePage(c.req.query("page")),
  };
  const perPage = 100;
  const [pendingRequestsPage, eventsPage] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    audit.list({
      pagination: { page: state.page, perPage },
      filter: {
        search: state.search || undefined,
        actor: state.actor || undefined,
        target: state.target || undefined,
        action: state.action || undefined,
        actionGroup: state.actionGroup || undefined,
        serviceAccountId: state.serviceAccountId || undefined,
        outcome: state.outcome || undefined,
        provider: state.provider || undefined,
        days: state.days,
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(eventsPage.total / perPage));
  const paginationBaseUrl = buildAuditUrl({ ...state, page: 1 }).replace(/(?:\?|&)page=\d+$/, "");
  const paginationUrl = paginationBaseUrl.includes("?") ? `${paginationBaseUrl}&page=` : `${paginationBaseUrl}?page=`;
  const actorFilterLabel = state.actor
    ? (eventsPage.items.find((event) => event.actor.userId === state.actor || event.actor.uid === state.actor)?.actor.uid ?? state.actor)
    : "";
  const targetFilterLabel = state.target
    ? (eventsPage.items.find((event) => event.target.id === state.target || event.target.label === state.target)?.target.label ??
      state.target)
    : "";
  const columns: DataTableColumn<AuditEvent>[] = [
    { id: "time", header: t.time, value: (event) => event.createdAt, cellClass: "whitespace-nowrap" },
    { id: "actor", header: t.actor, value: (event) => event.actor.uid ?? event.actor.userId },
    { id: "action", header: t.action, value: (event) => actionLabel(event.action, t) },
    { id: "target", header: t.target, value: (event) => event.target.label ?? event.target.id },
    { id: "outcome", header: t.outcome, value: (event) => event.outcome },
    { id: "reason", header: t.reason, value: (event) => event.reason, cellClass: "max-w-[24rem]" },
  ];
  const outcomeLabel = (outcome: AuditOutcome) => ({ allowed: t.allowed, denied: t.denied, failed: t.failed })[outcome];
  const targetTypeLabel = (type: string | null) =>
    type === "user" ? t.userTarget : type === "group" ? t.groupTarget : (type ?? t.targetType);

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.audit }]}>
      <AccountsWorkspace active="audit" isAdmin pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-audit">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-audit-title">
            <h1 class="text-base font-semibold text-primary">{t.auditLogTitle}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.auditEventCount({ count: eventsPage.total, days: state.days })}</p>
          </div>

          <div style="view-transition-name: accounts-audit-search">
            <SearchBar
              action={buildAuditUrl({ ...state, search: "", page: 1 })}
              value={state.search}
              placeholder={t.searchAudit}
              ariaLabel={t.searchAudit}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-audit-filters">
            <AuditFilters
              search={state.search}
              actor={state.actor}
              target={state.target}
              action={state.action}
              actionGroup={state.actionGroup}
              serviceAccountId={state.serviceAccountId}
              outcome={state.outcome}
              provider={state.provider}
              days={state.days}
            />
          </div>

          {state.actor || state.target || state.serviceAccountId ? (
            <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-audit-scope-filters">
              <span class="text-xs text-dimmed">{t.scopedTo}</span>
              {state.actor ? (
                <ButtonLink
                  href={buildAuditUrl({ ...state, actor: "", page: 1 })}
                  variant="subtle"
                  size="sm"
                  title={t.actorFilter({ value: state.actor })}
                >
                  <AccountAvatar name={actorFilterLabel} userId={state.actor} size="xs" class="h-4 w-4 text-xs" />
                  <span class="truncate">{t.actorFilter({ value: actorFilterLabel })}</span>
                  <i class="ti ti-x" />
                </ButtonLink>
              ) : null}
              {state.target ? (
                <ButtonLink
                  href={buildAuditUrl({ ...state, target: "", page: 1 })}
                  variant="subtle"
                  size="sm"
                  title={t.targetFilter({ value: state.target })}
                >
                  <AccountAvatar name={targetFilterLabel} userId={state.target} size="xs" class="h-4 w-4 text-xs" />
                  <span class="truncate">{t.targetFilter({ value: targetFilterLabel })}</span>
                  <i class="ti ti-x" />
                </ButtonLink>
              ) : null}
              {state.serviceAccountId ? (
                <ButtonLink
                  href={buildAuditUrl({ ...state, serviceAccountId: "", page: 1 })}
                  variant="subtle"
                  size="sm"
                  title={t.serviceAccountFilter({ value: state.serviceAccountId })}
                >
                  <i class="ti ti-user-key text-xs" />
                  <span class="truncate">{t.serviceAccountFilter({ value: state.serviceAccountId })}</span>
                  <i class="ti ti-x" />
                </ButtonLink>
              ) : null}
            </div>
          ) : null}

          {eventsPage.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.noAuditEvents}</>} />
          ) : (
            <Paper class="overflow-hidden" style="view-transition-name: accounts-audit-table">
              <DataTable
                rows={eventsPage.items}
                columns={columns}
                getRowId={(event) => String(event.id)}
                hoverRows
                highlightColumns={false}
                class="overflow-x-auto"
                scrollPreserveKey="accounts-audit-table"
                renderCell={({ row: event, col }) => {
                  if (col.id === "time") return <span class="text-dimmed">{dates.formatDateTime(event.createdAt, { locale })}</span>;
                  if (col.id === "actor") {
                    const actorLabel = event.actor.uid ?? event.actor.userId ?? t.system;
                    return (
                      <div class="flex min-w-0 items-center gap-2">
                        <AccountAvatar name={actorLabel} userId={event.actor.userId} size="xs" />
                        <div class="min-w-0 flex-1">
                          {event.actor.userId ? (
                            <ButtonLink
                              href={buildAuditUrl({ ...state, actor: event.actor.userId, page: 1 })}
                              class="block truncate font-medium text-primary hover:underline"
                            >
                              {actorLabel}
                            </ButtonLink>
                          ) : (
                            <span class="block truncate font-medium text-primary">{actorLabel}</span>
                          )}
                          {event.actor.provider ? <Tag>{event.actor.provider}</Tag> : null}
                        </div>
                      </div>
                    );
                  }
                  if (col.id === "action")
                    return (
                      <div class="flex min-w-0 flex-col gap-1">
                        <span class="truncate font-medium text-primary">{actionLabel(event.action, t)}</span>
                        <span class="truncate text-xs text-dimmed">{event.action}</span>
                      </div>
                    );
                  if (col.id === "target") {
                    const targetLabel = event.target.label ?? event.target.id ?? "-";
                    const href =
                      event.target.type === "user" && event.target.id
                        ? `/app/accounts/users/${event.target.id}`
                        : event.target.type === "group" && event.target.id
                          ? `/app/accounts/groups/${event.target.id}`
                          : null;
                    return (
                      <div class="flex min-w-0 items-center gap-2">
                        {event.target.type === "user" ? (
                          <AccountAvatar name={targetLabel} userId={event.target.id} size="xs" />
                        ) : (
                          <i class={`ti ${event.target.type === "group" ? "ti-users-group" : "ti-target"} text-xs`} />
                        )}
                        <div class="min-w-0 flex-1">
                          {href ? (
                            <a href={href} class="block truncate font-medium text-primary hover:underline">
                              {targetLabel}
                            </a>
                          ) : (
                            <span class="block truncate font-medium text-primary">{targetLabel}</span>
                          )}
                          <span class="block truncate text-xs text-dimmed">{targetTypeLabel(event.target.type)}</span>
                        </div>
                      </div>
                    );
                  }
                  if (col.id === "outcome")
                    return <StatusBadge tone={statusTone(event.outcome)} label={<> {outcomeLabel(event.outcome)} </>} />;
                  if (col.id === "reason")
                    return (
                      <span class="truncate text-dimmed" title={event.reason ?? event.errorMessage ?? ""}>
                        {event.reason ?? event.errorMessage ?? "-"}
                      </span>
                    );
                  return "";
                }}
              />
            </Paper>
          )}

          <div class="pt-1">
            <Pagination currentPage={state.page} totalPages={totalPages} baseUrl={paginationUrl} />
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
