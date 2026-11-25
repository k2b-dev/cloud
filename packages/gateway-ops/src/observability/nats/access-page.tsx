import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import NatsAccessScreen from "./_components/NatsAccessScreen.island";
import { readNatsAccess } from "./access-state";
import { natsMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [state, attention] = await Promise.all([readNatsAccess(), readAttention()]);
  const { t } = natsMessages.resolve([locale]);
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);
  // Only presence crosses SSR; decrypted access never reaches the island.
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: area.area, href: "/admin/observability" },
        { title: area.nats, href: "/admin/observability/nats" },
        { title: t.access },
      ]}
    >
      <ObservabilityNavigation label={area.area} current="nats" groups={groups} />
      <NatsAccessScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        values={{ servers: state.servers, kind: state.kind, ca: state.ca }}
        accessRequired={state.accessRequired}
        unreadable={state.unreadable}
      />
    </Layout>
  );
});
