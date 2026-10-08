import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { outgoingMailLog } from "@k2b/cloud/services/outgoing-mail/admin";
import { readMailRetention } from "@k2b/cloud/services/outgoing-mail/retention";
import { outgoingMailStore } from "@k2b/cloud/services/outgoing-mail/store";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { outgoingMailMessages } from "./messages";
import OutgoingMail from "./OutgoingMail.island";
import { parseSendLogFilter, SEND_LOG_PAGE_SIZE } from "./SendLog";

export default ssr<AuthContext>(async (c) => {
  const t = outgoingMailMessages.resolve([getLocale(c)]).t;
  const filter = parseSendLogFilter(c.req.query());
  const [profiles, apps, page, retention] = await Promise.all([
    outgoingMailStore.list(),
    outgoingMailStore.apps(),
    outgoingMailLog.list(
      {
        ...(filter.app ? { app: filter.app } : {}),
        ...(filter.status ? { status: [filter.status] } : {}),
        ...(filter.recipient ? { recipient: filter.recipient } : {}),
      },
      { perPage: SEND_LOG_PAGE_SIZE },
    ),
    readMailRetention(),
  ]);
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <OutgoingMail initial={{ profiles, apps, log: { filter, page, retention } }} />
      </div>
    </AdminLayout>
  );
});
