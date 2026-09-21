import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { type AuthContext, userFromActor } from "@k2b/cloud/server";
import { Layout, MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import Runner from "./Runner.island";
import { runnerMetadata } from "./runner-api";
import { ArtifactError, artifacts } from "./service";

export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const id = CodeResourceId.safeParse(c.req.param("id"));
  if (!id.success) return ssr.error(c, 404, { layout: "minimal" });
  const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const user = userFromActor(identity.actor);
  try {
    const metadata = runnerMetadata(await artifacts.runner(id.data, identity));
    c.get("page").title = metadata.title;
    const content = () => <Runner initial={metadata} userId={user?.id ?? "public-visitor"} />;
    return () =>
      user ? (
        <Layout c={c} title={[{ title: metadata.title }]} fullPage>
          {content()}
        </Layout>
      ) : (
        <MinimalLayout c={c}>
          <main class="assistant-standalone-page">{content()}</main>
        </MinimalLayout>
      );
  } catch (error) {
    if (error instanceof ArtifactError) {
      // Private links offer sign-in; authenticated callers receive an ordinary unavailable page.
      if (!user && error.code === "NOT_FOUND") {
        const rejection = await ssr.access.onReject(c, "unauthenticated");
        return typeof rejection === "string" ? c.redirect(rejection) : rejection;
      }
      return ssr.error(c, error.code === "ACCESS_DENIED" ? 403 : 404);
    }
    throw error;
  }
});
