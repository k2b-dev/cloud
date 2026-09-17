import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import Apps from "./Apps.island";
import { artifactDatabase } from "./database";
import { ArtifactPath } from "./contracts";

export default ssr<AuthContext>(async c => {
  const user = expectUserBackedActor(c), identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const t = artifactMessages.resolve([getLocale(c)]).t;
  const id = CodeResourceId.safeParse(c.req.param("id"));
  if (!id.success) return ssr.error(c, 404);
  try {
    const app = await artifacts.get(id.data, identity);
    if (app.permission !== "admin" && !c.req.path.endsWith("/edit") && !c.req.path.endsWith("/database")) return c.redirect(`/app/assistant/apps/${app.id}/run`);
    const sidebar = await loadAssistantSidebarSnapshot(user.id);
    const view=c.req.path.endsWith("/edit")?"edit":c.req.path.endsWith("/database")?"database":"app";
    if(view!=="app"&&app?.permission!=="admin")return ssr.error(c,403);
    const databaseStatus=view==="database"&&app?await artifactDatabase.status(app.id,identity,c.req.raw.signal):undefined;
    const selectedFile=ArtifactPath.safeParse(c.req.query("file"));
    return () => <Layout c={c} fullPage title={[{ title: t.apps, href: "/app/assistant?studio=1" }, { title: app.title }]}>
      <Apps userId={user.id} conversations={sidebar.conversations} doneCount={sidebar.doneCount} projects={sidebar.projects} initialApp={app}
        view={view} databaseStatus={databaseStatus} selectedFile={selectedFile.success?selectedFile.data:undefined}/>
    </Layout>;
  } catch (e) {
    if (e instanceof ArtifactError) return ssr.error(c, e.code === "ACCESS_DENIED" ? 403 : 404);
    throw e;
  }
});
