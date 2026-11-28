import { LocaleProvider } from "@k2b/ui";
import { fixtureBases, fixtureNav } from "../fixtures";
import SettingsScreen from "../SettingsScreen";

/** The usage of a base for a member, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <SettingsScreen
      nav={fixtureNav()}
      base={fixtureBases[0]!}
      tab="usage"
      canAdmin={false}
      admins={["Jana Petersen", "Jonas Wolf"]}
      maxRawRetentionDays={365}
      access={null}
      limits={null}
    />
  </LocaleProvider>
);
