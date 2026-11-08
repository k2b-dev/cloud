import type { CodePageTree } from "@k2b/cloud/code";
import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { Layout, MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import CodePageTreeView from "./PageTree.island";

export type HostedCodePage = { tree: CodePageTree; codeId: string; csrf: string; layout?: "plain" };
export type CodePageHostingContext = AuthContext & { Variables: { hostedCodePage: HostedCodePage } };
/**
 * Hosting validates the description before this final SSR handler. Only the tree is sent to the island. A page renders
 * inside the Cloud layout, signed in or not, like Core's own pages; a route declared with `layout: "plain"` renders
 * the page alone.
 */
export const codePageHandlers = ssr<CodePageHostingContext>((context) => {
  const { layout, ...page } = context.get("hostedCodePage");
  context.get("page").title = page.tree.title;
  const view = () => <CodePageTreeView {...page} locale={getLocale(context)} timeZone={getTimeZone(context)} />;
  return () =>
    layout === "plain" ? (
      <MinimalLayout c={context} preferences={false}>
        <main>{view()}</main>
      </MinimalLayout>
    ) : (
      <Layout c={context} title={page.tree.title}>
        {view()}
      </Layout>
    );
});
