import { type AuthContext, expectUserBackedActor, getDateConfig } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import { OverviewViewSchema } from "@/overview-contracts";
import { loadOverviewWork } from "@/service/overview";
import { ssr } from "../config";
import MyTasks from "./MyTasks.island";

/**
 * `/pwa/spaces?view=`: the person's open work in the mobile app, with the web overview's views and its
 * permission-filtered, bounded read. Tasks are checked off in place.
 */
export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = expectUserBackedActor(c);
  const parsed = OverviewViewSchema.safeParse(c.req.query("view"));
  const view = parsed.success ? parsed.data : "mine";
  const dateConfig = getDateConfig(c);
  const work = await loadOverviewWork({ userId: user.id, view, dateConfig });

  return () => (
    <PwaLayout c={c} title="Spaces">
      <MyTasks userId={user.id} initialView={view} initialWork={work} dateConfig={dateConfig} />
    </PwaLayout>
  );
});
