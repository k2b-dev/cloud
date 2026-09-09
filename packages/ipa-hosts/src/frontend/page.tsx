import { Pagination, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../config";
import { createPagination } from "../contracts";
import { ipaHostsService } from "../service";
import HostgroupCard from "./HostgroupCard";
import HostSettings from "./HostSettings.island";
import HostsTable from "./HostsTable";
import NewHostgroup from "./NewHostgroup.island";
import SyncHosts from "./SyncHosts.island";
import { hostMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = hostMessages.resolve([getLocale(c)]);
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawUngroupedPage = Number(c.req.query("ungrouped_page") ?? "1");
  const ungroupedPage = Number.isInteger(rawUngroupedPage) && rawUngroupedPage > 0 ? rawUngroupedPage : 1;
  const perPage = 100;
  const search = c.req.query("search") ?? "";

  const [hostgroupsPage, ungroupedHostsPage, hostStats] = await Promise.all([
    ipaHostsService.hostgroup.listWithHosts({
      pagination: { page, perPage },
      filter: { query: search || undefined },
    }),
    ipaHostsService.host.listUngrouped({
      pagination: { page: ungroupedPage, perPage },
      filter: { query: search || undefined },
    }),
    ipaHostsService.stats(),
  ]);
  const hostgroups = hostgroupsPage.items;
  const total = hostgroupsPage.total;
  const pagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, total);
  const ungroupedPagination = createPagination(
    { page: ungroupedPage, perPage, offset: (ungroupedPage - 1) * perPage },
    ungroupedHostsPage.total,
  );

  const buildBaseUrl = (pageParam: "page" | "ungrouped_page") => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (pageParam === "page" && ungroupedPage > 1) params.set("ungrouped_page", String(ungroupedPage));
    if (pageParam === "ungrouped_page" && page > 1) params.set("page", String(page));
    const prefix = params.toString();
    return prefix ? `/admin/ipa-hosts?${prefix}&${pageParam}=` : `/admin/ipa-hosts?${pageParam}=`;
  };

  // True totals from a single SQL aggregation: hostStats counts distinct hosts
  // across the whole mirror DB, including rows outside the visible page.
  const hostsInGroups = hostStats.hostsInGroups;

  return () => (
    <AdminLayout c={c} title="Hosts">
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-hosts-title">
          <h1 class="text-base font-semibold text-primary">Hosts</h1>
        </div>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={3}>
          <StatCell
            label={t.hostgroups}
            value={total}
            sub={search ? t.filtered : t.mirroredFromIpa}
            accent={{ tone: "blue", icon: "ti ti-server" }}
          />
          <StatCell label={t.hostsInGroups} value={hostsInGroups} sub={t.ofTotal({ total: hostStats.hostsTotal })} />
          <StatCell
            label={t.ungrouped}
            value={ungroupedHostsPage.total}
            sub={ungroupedHostsPage.total > 0 ? t.needsAssignment : t.allAssigned}
            valueClass={ungroupedHostsPage.total > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={
              ungroupedHostsPage.total > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : { tone: "emerald", icon: "ti ti-check" }
            }
          />
        </StatGrid>

        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 flex-1">
            <SearchBar action="/admin/ipa-hosts" value={search} placeholder={t.search} ariaLabel={t.searchLabel} />
          </div>
          <SyncHosts />
          <HostSettings />
          <NewHostgroup />
        </div>

        {ungroupedHostsPage.total > 0 || search ? (
          <section class="paper overflow-hidden" style="view-transition-name: admin-hosts-ungrouped">
            <div class="bg-[var(--ui-surface-subtle)] px-3 py-3">
              <div class="flex items-center gap-3">
                <i class="ti ti-server-off shrink-0 text-lg text-amber-500" />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold text-primary">{t.ungroupedHosts}</div>
                  <div class="text-xs text-dimmed">
                    {t.hostCount({ count: ungroupedHostsPage.total })} {t.withoutGroup}
                  </div>
                </div>
              </div>
            </div>
            <HostsTable hosts={ungroupedHostsPage.items} emptyMessage={search ? t.noUngroupedMatch({ query: search }) : t.noUngrouped} />
            {ungroupedPagination.total_pages > 1 ? (
              <div class="px-3 py-3">
                <Pagination
                  currentPage={ungroupedPagination.page}
                  totalPages={ungroupedPagination.total_pages}
                  baseUrl={buildBaseUrl("ungrouped_page")}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {hostgroups.length > 0 ? (
          <>
            {hostgroups.map((hostgroup) => (
              <HostgroupCard hostgroup={hostgroup} hosts={hostgroup.hostDetails} />
            ))}
            <Pagination currentPage={pagination.page} totalPages={pagination.total_pages} baseUrl={buildBaseUrl("page")} />
          </>
        ) : (
          <Placeholder surface="paper" description={<>{search ? t.noGroupMatch({ query: search }) : t.noGroups}</>} />
        )}
      </div>
    </AdminLayout>
  );
});
