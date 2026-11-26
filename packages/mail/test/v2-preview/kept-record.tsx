import { LocaleProvider } from "@k2b/ui";
import MailAdminKeptRecord from "../../src/frontend/_components/v2/MailAdminKeptRecord.island";
import { keptAdminNav, keptDateConfig, keptRecord } from "../../src/frontend/_components/v2/mail-admin-kept.browser-fixture";

export const app = { color: "#0284c7", icon: "settings" };
export const locale = "de";

export default function KeptRecord() {
  // the app reads its words from @k2b/ui (the built package); the preview resolves only v2 to source
  return (
    <LocaleProvider locale="de">
      <MailAdminKeptRecord nav={keptAdminNav()} record={keptRecord()} dateConfig={keptDateConfig} />
    </LocaleProvider>
  );
}
