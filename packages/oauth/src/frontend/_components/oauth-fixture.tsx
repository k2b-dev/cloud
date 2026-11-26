import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import OAuthScreen from "./OAuthScreen";
import { NORMAL, WORST } from "./oauth-fixture-data";

// The OAuth screen from invented clients (see `oauth-fixture-data.ts`); `empty` has none.

export type OAuthFixtureData = "normal" | "worst" | "empty";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "OAuth", icon: "key", href: "/admin/oauth", current: true }] }],
};

/** `nav` is the shell's own admin navigation when the screen stands in the real page (dialog pictures). */
export const OAuthFixture = (props: { search: string; data?: OAuthFixtureData; nav?: NavProps }) => {
  const params = new URLSearchParams(props.search);
  const clients = props.data === "worst" ? WORST : props.data === "empty" ? [] : NORMAL;
  const open = params.get("client");
  return (
    <LocaleProvider locale="de">
      <OAuthScreen
        nav={props.nav ?? nav}
        baseUrl="https://cloud.example.test"
        tab={params.get("tab") === "endpoints" ? "endpoints" : "clients"}
        search={params.get("search") ?? ""}
        paging={{ page: 1, pages: props.data === "worst" ? 247 : 1 }}
        clients={clients}
        figures={
          props.data === "worst"
            ? { total: 12_345, public: 4_321, dynamic: 9_876 }
            : {
                total: clients.length,
                public: clients.filter((client) => client.isPublic).length,
                dynamic: clients.filter((client) => client.registrationKind === "dynamic").length,
              }
        }
        open={open ? { id: open, found: clients.find((client) => client.id === open) ?? null } : null}
      />
    </LocaleProvider>
  );
};
