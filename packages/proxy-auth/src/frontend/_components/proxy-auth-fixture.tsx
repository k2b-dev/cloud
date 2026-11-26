import { groupDisplayName } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import ProxyAuthScreen from "./ProxyAuthScreen";
import { fixtureClients, type ProxyAuthFixtureData } from "./proxy-auth-fixture-data";

// The Proxy Auth screen from invented clients (see `proxy-auth-fixture-data.ts`), worded as the page words them.

const harnessNav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Proxy-Authentifizierung", icon: "shield-half", href: "/admin/proxy-auth", current: true }] }],
};

/** `nav` is the shell's own admin navigation when the screen stands in the real page (dialog pictures). */
export const ProxyAuthFixture = (props: { search: string; data?: ProxyAuthFixtureData; nav?: NavProps }) => {
  const clients = fixtureClients(props.data ?? "normal").map((client) => ({
    id: client.id,
    clientId: client.clientId,
    name: client.name,
    description: client.description,
    groups: client.allowedGroups.map((group) => ({ id: group.id, label: groupDisplayName(group.name, "de") })),
    created: new Date(client.createdAt).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }),
  }));
  return (
    <LocaleProvider locale="de">
      <ProxyAuthScreen
        nav={props.nav ?? harnessNav}
        baseUrl="https://cloud.example.test"
        clients={clients}
        open={new URLSearchParams(props.search).get("client")}
        tab={new URLSearchParams(props.search).get("tab") === "setup" ? "setup" : "clients"}
        figures={{
          withoutGroups: clients.filter((client) => client.groups.length === 0).length,
        }}
      />
    </LocaleProvider>
  );
};
