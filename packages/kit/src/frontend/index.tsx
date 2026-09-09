import { PublicId } from "../contracts";
import { Hono } from "hono";
import { auth, expectUserBackedActor, type AuthContext } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { projects, ProjectError } from "../service";
import Overview from "./Overview.island";
import Workbench from "./Workbench.island";
const overview = ssr<AuthContext>(async (c) => {
  const page = Math.max(1, Math.min(100000, Number(c.req.query("page")) || 1));
  const query = (c.req.query("q") ?? "").slice(0, 120);
  const result = await projects.list({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, Math.floor(page), query);
  return () => (
    <Layout c={c} title={[{ title: "Cloud", href: "/" }, { title: "Kit" }]}>
      <Overview items={result.items} page={result.page} hasNext={result.hasNext} query={query} />
    </Layout>
  );
});
const toolPage = (edit: boolean) =>
  ssr<AuthContext>(async (c) => {
    const id = PublicId.safeParse(c.req.param("id"));
    if (!id.success) return ssr.error(c, 404);
    try {
      const identity = {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      };
      const project = await projects.get(id.data, identity, edit ? "admin" : "write");
      const access = edit ? await projects.access(project.id, identity) : [];
      const selected = c.req.query("page");
      const entry = project.entries.find((e) => e.path === selected)?.path ?? project.entries[0]!.path;
      const user = expectUserBackedActor(c);
      return () => (
        <Layout c={c} title={[{ title: "Kit", href: "/app/kit" }, { title: project.name }]} fullWidth fullPage>
          <Workbench project={project} userId={user.id} edit={edit} entry={entry} access={access} />
        </Layout>
      );
    } catch (e) {
      if (e instanceof ProjectError) return ssr.error(c, e.status);
      throw e;
    }
  });
export default new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated", ssr.access))
  .get("/", ...overview)
  .get("/:id/edit", ...toolPage(true))
  .get("/:id", ...toolPage(false));
