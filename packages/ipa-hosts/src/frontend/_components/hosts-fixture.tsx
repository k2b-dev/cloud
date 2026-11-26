import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import type { IpaHost, IpaHostgroup } from "@/contracts";
import HostsScreen from "./HostsScreen";
import { denseGroups, denseUngrouped, fixtureHost } from "./hosts-fixture-data";

// Invented hosts for render and browser tests: no production data. `worst` carries long names, many MAC addresses and
// groups, missing fields and five-digit counts; `empty` has nothing mirrored yet.

export type HostsFixtureData = "normal" | "worst" | "empty";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Hosts", icon: "server", href: "/admin/ipa-hosts", current: true }] }],
};

const host = fixtureHost;
const NORMAL_GROUPS = denseGroups();

const LONG = "kunden-und-auftraege-werkstatt-nord-zeiterfassung-und-materialbestellung-01.intern.werkstatt-nord.example";
const WORST_GROUPS: (IpaHostgroup & { hostDetails: IpaHost[] })[] = [
  {
    cn: "werkstatt-nord-schichtbetrieb-maschinen-und-messplaetze-im-erdgeschoss",
    description: "Alle Maschinen, Messplätze und Bedienterminals der Werkstatt Nord im Erdgeschoss, die im Schichtbetrieb laufen",
    hosts: [LONG],
    hostgroups: Array.from({ length: 6 }, (_, index) => `untergruppe-${index + 1}`),
    hostDetails: [
      host(LONG, {
        description: "Терминал · 工作站 · محطة عمل 🖥️",
        locality: "Werkstatt Nord, Erdgeschoss, Halle 7 (Anbau)",
        location: "Rack 12, Höheneinheit 38–40",
        memberofHostgroup: Array.from({ length: 8 }, (_, index) => `gruppe-${index + 1}`),
        macAddress: Array.from({ length: 6 }, (_, index) => `AA:BB:CC:DD:EE:0${index}`),
        sshFingerprints: Array.from({ length: 3 }, (_, index) => `SHA256:${"x".repeat(43)}${index} (RSA)`),
      }),
    ],
  },
  { cn: "x", description: null, hosts: [], hostgroups: [], hostDetails: [] },
];

export const HostsFixture = (props: { search: string; data?: HostsFixtureData }) => {
  const params = new URLSearchParams(props.search);
  const data = props.data ?? "normal";
  const groups = data === "worst" ? WORST_GROUPS : data === "empty" ? [] : NORMAL_GROUPS;
  const ungrouped =
    data === "worst"
      ? [host("a"), host(LONG.replace("01", "02"), { macAddress: ["AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:F1"] })]
      : data === "empty"
        ? []
        : denseUngrouped();
  const everyHost = [...groups.flatMap((group) => group.hostDetails), ...ungrouped];
  const groupName = params.get("group");
  const fqdn = params.get("host");
  return (
    <LocaleProvider locale="de">
      <HostsScreen
        nav={nav}
        tab={params.get("tab") === "ungrouped" ? "ungrouped" : "groups"}
        search={params.get("search") ?? ""}
        figures={{
          groups: data === "worst" ? 12_345 : groups.length,
          hostsInGroups: data === "worst" ? 98_765 : groups.reduce((sum, group) => sum + group.hostDetails.length, 0),
          hostsTotal: data === "worst" ? 123_456 : everyHost.length,
          ungrouped: data === "worst" ? 24_691 : ungrouped.length,
        }}
        groups={groups}
        ungrouped={ungrouped}
        paging={{ page: 1, pages: data === "worst" ? 124 : 1 }}
        group={groupName ? { cn: groupName, found: groups.find((group) => group.cn === groupName) ?? null } : null}
        host={fqdn ? { fqdn, found: everyHost.find((candidate) => candidate.fqdn === fqdn) ?? null } : null}
      />
    </LocaleProvider>
  );
};
