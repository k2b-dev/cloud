import { type AuthContext, getLocale, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { pulseMessages } from "../../messages";
import PulseWorkspace from "../PulseWorkspace.island";
import { loadPulseWorkspacePageData } from "./page-data";

export default ssr<AuthContext>(async (c) => {
  setRequestTimeout(c, 60);
  let data: Awaited<ReturnType<typeof loadPulseWorkspacePageData>>;
  try {
    data = await loadPulseWorkspacePageData(c);
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
  const { t } = pulseMessages.resolve([getLocale(c)]);

  if (data.kind === "error") {
    return ssr.error(c, data.status, { action: { label: t.backToPulse, href: "/app/pulse" } });
  }

  const workspaceProps = data.workspaceProps;

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/pulse" }, { title: data.baseName }]}>
      <PulseWorkspace {...workspaceProps} />
    </Layout>
  );
});
