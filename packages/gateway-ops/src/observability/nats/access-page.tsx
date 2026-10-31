import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { readNatsAccess } from "./access-state";
import { NatsAccessView } from "./access-view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [state, attention] = await Promise.all([readNatsAccess(), readAttention()]);
  // Only presence crosses SSR; decrypted access never reaches the island.
  return () => (
    <NatsAccessView
      c={c}
      locale={locale}
      attention={attention}
      values={{ servers: state.servers, kind: state.kind, ca: state.ca }}
      accessRequired={state.accessRequired}
      unreadable={state.unreadable}
    />
  );
});
