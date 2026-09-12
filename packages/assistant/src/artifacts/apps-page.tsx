import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { z } from "zod";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import { ArtifactKind } from "./contracts";
import Apps from "./Apps.island";
import { artifactDatabase } from "./database";
import { ArtifactPath } from "./contracts";
import { DbName } from "./database-contracts";

export default ssr<AuthContext>(async c => {
  const user = expectUserBackedActor(c), identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const kind = ArtifactKind.catch("app").parse(c.req.query("kind") ?? "app");
  const t = artifactMessages.resolve([getLocale(c)]).t;
  if (c.req.param("id") && !z.uuid().safeParse(c.req.param("id")).success) return ssr.error(c, 404);
  try {
    const [sidebar, list, app] = await Promise.all([
      loadAssistantSidebarSnapshot(user.id), artifacts.list(identity, z.coerce.number().int().min(1).max(100000).catch(1).parse(c.req.query("page") ?? 1), kind),
      c.req.param("id") ? artifacts.get(c.req.param("id")!, identity) : undefined,
    ]);
    const view=c.req.path.endsWith("/edit")?"edit":c.req.path.endsWith("/database")?"database":"app";
    if(view!=="app"&&app?.permission!=="admin")return ssr.error(c,403);
    const databaseStatus=view==="database"&&app?await artifactDatabase.status(app.id,identity,c.req.raw.signal):undefined;
    const selectedFile=ArtifactPath.safeParse(c.req.query("file")),selectedTable=DbName.safeParse(c.req.query("table"));
    return () => <Layout c={c} fullPage title={[{ title: t.apps, href: "/app/assistant/apps" }, ...(app ? [{ title: app.title }] : [])]}>
      <Apps kind={kind} userId={user.id} conversations={sidebar.conversations} projects={sidebar.projects} initialList={list} initialApp={app}
        view={view} databaseStatus={databaseStatus} selectedFile={selectedFile.success?selectedFile.data:undefined} selectedTable={selectedTable.success?selectedTable.data:undefined}/>
    </Layout>;
  } catch (e) {
    if (e instanceof ArtifactError) return ssr.error(c, e.code === "ACCESS_DENIED" ? 403 : 404);
    throw e;
  }
});
