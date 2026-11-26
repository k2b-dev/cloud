import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { createPagination } from "../contracts";
import { ipaHostsService } from "../service";
import HostsScreen from "./_components/HostsScreen.island";
import { hostMessages } from "./messages";

const PER_PAGE = 100;
const GROUP_HOSTS_PER_PAGE = 50;

/** A page number from the address: a whole number from 1 whose offset the database can still take, else 1. */
const pageOf = (raw: string | undefined, perPage: number) => {
  const page = Number(raw ?? "1");
  return Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * perPage) ? page : 1;
};

/** How many pages `total` items fill, at least one. */
const pagesOf = (total: number, perPage: number) => Math.max(1, Math.ceil(total / perPage));

/**
 * Hosts on v2: the host groups mirrored from FreeIPA (`page`) and the hosts without a group (`tab=ungrouped`,
 * `ungrouped_page`), searched by `search`. An open group (`group=<cn>`) or host (`host=<fqdn>`) is read on its own, so
 * it stays open on any page and with any search.
 */
export default ssr<AuthContext>(async (c) => {
  const { t } = hostMessages.resolve([getLocale(c)]);
  const tab = c.req.query("tab") === "ungrouped" ? "ungrouped" : "groups";
  const page = pageOf(c.req.query("page"), PER_PAGE);
  const ungroupedPage = pageOf(c.req.query("ungrouped_page"), PER_PAGE);
  const search = c.req.query("search")?.trim().slice(0, 200) ?? "";
  const groupName = c.req.query("group")?.trim().slice(0, 255) || null;
  const fqdn = c.req.query("host")?.trim().slice(0, 253) || null;
  const hostsPage = pageOf(c.req.query("hosts_page"), GROUP_HOSTS_PER_PAGE);

  const [groupsPage, ungroupedHosts, stats, openGroup, openHost] = await Promise.all([
    ipaHostsService.hostgroup.listWithHosts({ pagination: { page, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    ipaHostsService.host.listUngrouped({ pagination: { page: ungroupedPage, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    ipaHostsService.stats(),
    // an open record is read by its exact name, so it opens on any page, with any search, among any number of names
    // a group of any size opens with one page of its hosts
    groupName ? ipaHostsService.hostgroup.getWithHosts({ cn: groupName, page: hostsPage, perPage: GROUP_HOSTS_PER_PAGE }) : null,
    fqdn ? ipaHostsService.host.get({ fqdn }) : null,
  ]);
  // A page past the end (a list that shrank, an old link) opens the last page instead of an empty one.
  const last = {
    page: pagesOf(groupsPage.total, PER_PAGE),
    ungrouped_page: pagesOf(ungroupedHosts.total, PER_PAGE),
    hosts_page: pagesOf(openGroup?.hostTotal ?? 0, GROUP_HOSTS_PER_PAGE),
  };
  const past = (
    [
      ["page", page],
      ["ungrouped_page", ungroupedPage],
      ["hosts_page", hostsPage],
    ] as const
  ).filter(([name, value]) => value > last[name] && (name !== "hosts_page" || openGroup));
  if (past.length > 0) {
    const url = new URL(c.req.url);
    for (const [name] of past) url.searchParams.set(name, String(last[name]));
    return c.redirect(`${url.pathname}${url.search}`, 302);
  }
  const pagination =
    tab === "groups"
      ? createPagination({ page, perPage: PER_PAGE, offset: (page - 1) * PER_PAGE }, groupsPage.total)
      : createPagination({ page: ungroupedPage, perPage: PER_PAGE, offset: (ungroupedPage - 1) * PER_PAGE }, ungroupedHosts.total);

  return () => (
    <AdminLayout c={c} ui="v2" title={t.hosts}>
      <HostsScreen
        nav={adminNavigation(c)}
        tab={tab}
        search={search}
        figures={{
          groups: groupsPage.total,
          hostsTotal: stats.hostsTotal,
          ungrouped: ungroupedHosts.total,
        }}
        groups={groupsPage.items}
        ungrouped={ungroupedHosts.items}
        paging={{ page: pagination.page, pages: pagination.total_pages }}
        group={
          groupName
            ? {
                cn: groupName,
                found: openGroup,
                paging: { page: hostsPage, pages: last.hosts_page },
              }
            : null
        }
        host={fqdn ? { fqdn, found: openHost } : null}
      />
    </AdminLayout>
  );
});
