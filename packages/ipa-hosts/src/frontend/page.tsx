import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { createPagination } from "../contracts";
import { ipaHostsService } from "../service";
import HostsScreen from "./_components/HostsScreen.island";
import { hostMessages } from "./messages";

const PER_PAGE = 100;
const GROUP_HOSTS_PER_PAGE = 50;

const pageOf = (raw: string | undefined) => {
  const page = Number(raw ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
};

/**
 * Hosts on v2: the host groups mirrored from FreeIPA (`page`) and the hosts without a group (`tab=ungrouped`,
 * `ungrouped_page`), searched by `search`. An open group (`group=<cn>`) or host (`host=<fqdn>`) is read on its own, so
 * it stays open on any page and with any search.
 */
export default ssr<AuthContext>(async (c) => {
  const { t } = hostMessages.resolve([getLocale(c)]);
  const tab = c.req.query("tab") === "ungrouped" ? "ungrouped" : "groups";
  const page = pageOf(c.req.query("page"));
  const ungroupedPage = pageOf(c.req.query("ungrouped_page"));
  const search = c.req.query("search")?.trim().slice(0, 200) ?? "";
  const groupName = c.req.query("group")?.trim().slice(0, 255) || null;
  const fqdn = c.req.query("host")?.trim().slice(0, 253) || null;
  const hostsPage = pageOf(c.req.query("hosts_page"));

  const [groupsPage, ungroupedHosts, stats, openGroup, openHost] = await Promise.all([
    ipaHostsService.hostgroup.listWithHosts({ pagination: { page, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    ipaHostsService.host.listUngrouped({ pagination: { page: ungroupedPage, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    ipaHostsService.stats(),
    // an open record is read by its exact name, so it opens on any page, with any search, among any number of names
    // a group of any size opens with one page of its hosts
    groupName ? ipaHostsService.hostgroup.getWithHosts({ cn: groupName, page: hostsPage, perPage: GROUP_HOSTS_PER_PAGE }) : null,
    fqdn ? ipaHostsService.host.get({ fqdn }) : null,
  ]);
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
          hostsInGroups: stats.hostsInGroups,
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
                paging: { page: hostsPage, pages: Math.max(1, Math.ceil((openGroup?.hostTotal ?? 0) / GROUP_HOSTS_PER_PAGE)) },
              }
            : null
        }
        host={fqdn ? { fqdn, found: openHost } : null}
      />
    </AdminLayout>
  );
});
