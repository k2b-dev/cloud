import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { pulseMessages } from "../messages";
import { pulseService } from "../service";
import { projectBases } from "../service/public-resources";
import PulseOverview from "./PulseOverview.island";

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const [basesResult, deletingResult] = await Promise.all([pulseService.base.list(user), pulseService.base.listDeleting(user)]);
  const bases = basesResult.ok ? await projectBases(basesResult.data) : [];
  const deletingBases = deletingResult.ok ? await projectBases(deletingResult.data) : [];
  const { t } = pulseMessages.resolve([getLocale(c)]);

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <PulseOverview bases={bases} deletingBases={deletingBases} initialQuery={url.searchParams.get("q")?.trim() ?? ""} />
    </Layout>
  );
});
