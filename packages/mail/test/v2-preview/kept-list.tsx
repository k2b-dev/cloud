import { LocaleProvider } from "@k2b/ui";
import MailAdminKeptList from "../../src/frontend/_components/v2/MailAdminKeptList.island";
import { keptAdminNav, keptRows } from "../../src/frontend/_components/v2/mail-admin-kept.browser-fixture";

export const app = { color: "#0284c7", icon: "settings" };
export const locale = "de";

export default function KeptList() {
  // the app reads its words from @k2b/ui (the built package); the preview resolves only v2 to source
  return (
    <LocaleProvider locale="de">
      <MailAdminKeptList nav={keptAdminNav()} rows={keptRows(18)} total={214} failure={null} query="" cursor={null} nextCursor="next" />
    </LocaleProvider>
  );
}
