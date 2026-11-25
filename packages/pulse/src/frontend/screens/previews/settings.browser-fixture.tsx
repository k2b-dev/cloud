import { LocaleProvider } from "@k2b/ui";
import { fixtureBases } from "../fixtures";
import SettingsScreen from "../SettingsScreen";

/** The general settings of a base for an admin, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <SettingsScreen
      bases={fixtureBases}
      base={fixtureBases[0]!}
      tab="general"
      canAdmin
      admins={[]}
      maxRawRetentionDays={365}
      access={null}
      limits={null}
    />
  </LocaleProvider>
);
