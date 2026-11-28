import { LocaleProvider } from "@k2b/ui";
import { fixtureBases, fixtureNav } from "../fixtures";
import SettingsScreen from "../SettingsScreen";

/** The retention settings of a base for an admin, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <SettingsScreen
      nav={fixtureNav()}
      base={fixtureBases[0]!}
      tab="retention"
      canAdmin
      admins={[]}
      maxRawRetentionDays={365}
      access={null}
      limits={null}
    />
  </LocaleProvider>
);
