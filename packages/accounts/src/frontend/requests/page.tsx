import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, type DataTableColumn, Pagination, Paper, Placeholder, StatusBadge, type StatusTone } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@valentinkolb/cloud/services";
import { readAccountCategoryPolicy } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import DenyRequest from "../users/DenyRequest.island";
import CreateUserForm from "../users/new/CreateUserForm.island";

type StatusFilter = "pending" | "completed" | "denied" | "all";

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const parseStatus = (value: string | undefined): StatusFilter => {
  if (value === "pending" || value === "completed" || value === "denied" || value === "all") return value;
  return "pending";
};

const buildRequestsUrl = (status: StatusFilter, page: number): string => {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query.length > 0 ? `/app/accounts/requests?${query}` : "/app/accounts/requests";
};

const STATUS_TONE: Record<Exclude<StatusFilter, "all">, StatusTone> = {
  pending: "neutral",
  completed: "ok",
  denied: "error",
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const statusLabel = (value: StatusFilter) =>
    value === "all" ? t.all : value === "pending" ? t.pending : value === "completed" ? t.completed : t.denied;
  const user = expectUserBackedActor(c);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const categoryPolicy = await readAccountCategoryPolicy();
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const status = parseStatus(c.req.query("status"));

  const [pendingPage, requestsPage] = await Promise.all([
    accountsService.accountRequest.list({
      access: { userId: user.id, isAdmin: true },
      filter: { status: "pending" },
    }),
    accountsService.accountRequest.list({
      access: { userId: user.id, isAdmin: true },
      pagination: { page, perPage },
      filter: status === "all" ? { scope: "all" } : { status },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(requestsPage.total / perPage));
  const paginationBaseUrl = buildRequestsUrl(status, 1).replace(/(?:\?|&)page=\d+$/, "");
  const paginationUrl = paginationBaseUrl.includes("?") ? `${paginationBaseUrl}&page=` : `${paginationBaseUrl}?page=`;
  type RequestRow = (typeof requestsPage.items)[number];
  const columns: DataTableColumn<RequestRow>[] = [
    { id: "request", header: t.request, value: (request) => request.displayName || `${request.firstName} ${request.lastName}` },
    { id: "email", header: t.email, value: (request) => request.email },
    { id: "status", header: t.status, value: (request) => request.status },
    { id: "requested", header: t.requested, value: (request) => request.createdAt, cellClass: "whitespace-nowrap" },
    { id: "comment", header: t.comment, value: (request) => request.comment, cellClass: "max-w-[20rem]" },
    { id: "actions", header: t.actions, headerClass: "text-right", cellClass: "text-right whitespace-nowrap max-w-none" },
  ];

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.requests }]}>
      <AccountsWorkspace active="requests" isAdmin={true} pendingRequests={pendingPage.total} scrollPreserveKey="accounts-requests">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-requests-title">
            <h1 class="text-base font-semibold text-primary">{t.requests}</h1>
            <p class="mt-1 text-xs text-dimmed">
              {t.requestCount({ count: requestsPage.total, status: status === "all" ? undefined : status })}
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-requests-filters">
            {(["pending", "completed", "denied", "all"] as const).map((value) => (
              <ButtonLink
                href={buildRequestsUrl(value, 1)}
                size="sm"
                variant={status === value ? "primary" : "subtle"}
                aria-current={status === value ? "page" : undefined}
              >
                {statusLabel(value)}
              </ButtonLink>
            ))}
            <div class="ml-auto">
              <CreateUserForm freeIpaEnabled={freeIpaEnabled} categoryPolicy={categoryPolicy} />
            </div>
          </div>

          {requestsPage.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.noRequests}</>} />
          ) : (
            <>
              <Paper class="overflow-hidden" style="view-transition-name: accounts-requests-table">
                <DataTable
                  rows={requestsPage.items}
                  columns={columns}
                  getRowId={(request) => request.id}
                  hoverRows
                  class="overflow-x-auto"
                  scrollPreserveKey="accounts-requests-table"
                  renderCell={({ row: request, col }) => {
                    if (col.id === "request")
                      return (
                        <span class="font-medium text-primary">{request.displayName || `${request.firstName} ${request.lastName}`}</span>
                      );
                    if (col.id === "email") return <span class="text-dimmed">{request.email}</span>;
                    if (col.id === "status")
                      return <StatusBadge tone={STATUS_TONE[request.status]} label={<> {statusLabel(request.status)} </>} />;
                    if (col.id === "requested") return <span class="text-dimmed">{dates.formatDate(request.createdAt, { locale })}</span>;
                    if (col.id === "comment")
                      return (
                        <span class="truncate text-dimmed" title={request.comment || "-"}>
                          {request.comment || "-"}
                        </span>
                      );
                    if (col.id === "actions") {
                      return request.status === "pending" ? (
                        <div class="flex justify-end gap-1">
                          {freeIpaEnabled ? (
                            <CreateUserForm
                              categoryPolicy={categoryPolicy}
                              buttonLabel={t.create}
                              buttonIcon="ti ti-user-plus"
                              freeIpaEnabled={freeIpaEnabled}
                              prefill={{
                                requestId: request.id,
                                email: request.email,
                                givenname: request.firstName,
                                sn: request.lastName,
                                displayName: request.displayName ?? undefined,
                                firstName: request.firstName,
                              }}
                            />
                          ) : null}
                          <DenyRequest requestId={request.id} email={request.email} firstName={request.firstName} />
                        </div>
                      ) : (
                        <span class="text-dimmed">-</span>
                      );
                    }
                    return "";
                  }}
                />
              </Paper>

              <div class="pt-1">
                <Pagination currentPage={requestsPage.page} totalPages={totalPages} baseUrl={paginationUrl} />
              </div>
            </>
          )}
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
