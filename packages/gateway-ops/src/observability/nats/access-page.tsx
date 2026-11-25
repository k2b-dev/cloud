import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { observabilityAdminNav } from "../_components/admin-nav";
import { readAttention } from "../_components/ObservabilityArea";
import NatsAccessScreen from "./_components/NatsAccessScreen.island";
import { readNatsAccess } from "./access-state";
import { natsMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [state, attention] = await Promise.all([readNatsAccess(), readAttention()]);
  const { t } = natsMessages.resolve([locale]);
  // Only presence crosses SSR; decrypted access never reaches the island.
  return () => (
    <AdminLayout c={c} ui="v2" title={t.access}>
      <NatsAccessScreen
        nav={observabilityAdminNav(c, locale, attention, "infrastructure")}
        values={{ servers: state.servers, kind: state.kind, ca: state.ca }}
        accessRequired={state.accessRequired}
        unreadable={state.unreadable}
      />
    </AdminLayout>
  );
});
