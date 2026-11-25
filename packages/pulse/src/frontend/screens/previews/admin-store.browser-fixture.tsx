import { LocaleProvider } from "@k2b/ui";
import AdminScreen from "../../admin/AdminScreen";
import { fixtureAdminBases, fixtureAdminNav, fixturePolicy, fixtureTargets } from "../../admin/admin-fixtures";

/** Pulse in the administration on its store section, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <AdminScreen
      nav={fixtureAdminNav("store")}
      view="store"
      store={{ configured: true, url: "http://clickhouse:8123", user: "pulse", passwordSet: true }}
      policy={fixturePolicy}
      bases={fixtureAdminBases}
      targets={fixtureTargets}
    />
  </LocaleProvider>
);
