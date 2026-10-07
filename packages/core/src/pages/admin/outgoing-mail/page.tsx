import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { outgoingMailStore } from "@k2b/cloud/services/outgoing-mail/store";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { outgoingMailMessages } from "./messages";
import OutgoingMail from "./OutgoingMail.island";

export default ssr<AuthContext>(async (c) => {
  const t = outgoingMailMessages.resolve([getLocale(c)]).t;
  const [profiles, apps] = await Promise.all([outgoingMailStore.list(), outgoingMailStore.apps()]);
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <OutgoingMail initial={{ profiles, apps }} />
      </div>
    </AdminLayout>
  );
});
