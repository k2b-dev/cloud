import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { app, ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { NatsAccessView } from "./access-view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [servers, kind, access, ca, attention] = await Promise.all([
    app.settings.read("gateway.nats_admin_servers"),
    app.settings.read("gateway.nats_admin_access_kind"),
    app.settings.read("gateway.nats_admin_access"),
    app.settings.read("gateway.nats_admin_tls_ca"),
    readAttention(),
  ]);
  // Only presence crosses SSR; the decrypted access value never reaches the island.
  const unreadable = {
    servers: servers.stored === "unreadable",
    kind: kind.stored === "unreadable",
    access: access.stored === "unreadable",
    ca: ca.stored === "unreadable",
  };
  return () => (
    <NatsAccessView
      c={c}
      locale={locale}
      attention={attention}
      values={{ servers: servers.value, kind: kind.value, ca: ca.value }}
      unreadable={unreadable}
    />
  );
});
