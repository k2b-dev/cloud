import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import HostsScreen from "./HostsScreen";
import { denseGroups, denseUngrouped, worstGroups, worstUngrouped } from "./hosts-fixture-data";

// Invented hosts for render and browser tests: no production data. `worst` carries long names, many MAC addresses and
// groups, missing fields and five-digit counts; `empty` has nothing mirrored yet.

export type HostsFixtureData = "normal" | "worst" | "empty";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Hosts", icon: "server", href: "/admin/ipa-hosts", current: true }] }],
};

const NORMAL_GROUPS = denseGroups();
const WORST_GROUPS = worstGroups();

/** `nav` is the shell's own admin navigation when the screen stands in the real page (dialog pictures). */
export const HostsFixture = (props: { search: string; data?: HostsFixtureData; nav?: NavProps }) => {
  const params = new URLSearchParams(props.search);
  const data = props.data ?? "normal";
  const groups = data === "worst" ? WORST_GROUPS : data === "empty" ? [] : NORMAL_GROUPS;
  const ungrouped = data === "worst" ? worstUngrouped() : data === "empty" ? [] : denseUngrouped();
  const everyHost = [...groups.flatMap((group) => group.hostDetails), ...ungrouped];
  const groupName = params.get("group");
  const fqdn = params.get("host");
  return (
    <LocaleProvider locale="de">
      <HostsScreen
        nav={props.nav ?? nav}
        tab={params.get("tab") === "ungrouped" ? "ungrouped" : "groups"}
        search={params.get("search") ?? ""}
        figures={{
          groups: data === "worst" ? 12_345 : groups.length,
          hostsTotal: data === "worst" ? 123_456 : everyHost.length,
          ungrouped: data === "worst" ? 24_691 : ungrouped.length,
        }}
        groups={groups}
        ungrouped={ungrouped}
        paging={{ page: 1, pages: data === "worst" ? 124 : 1 }}
        group={(() => {
          if (!groupName) return null;
          const found = groups.find((group) => group.cn === groupName);
          return { cn: groupName, found: found ? { ...found, hostTotal: found.hostDetails.length } : null, paging: { page: 1, pages: 1 } };
        })()}
        host={fqdn ? { fqdn, found: everyHost.find((candidate) => candidate.fqdn === fqdn) ?? null } : null}
      />
    </LocaleProvider>
  );
};
