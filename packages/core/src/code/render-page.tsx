import type { CodePageTree } from "@k2b/cloud/code";
import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { Layout, MinimalLayout } from "@k2b/cloud/ssr";
import { AppWorkspace } from "@k2b/ui";
import { ssr } from "../config";
import CodePageHost from "./PageHost";

export type HostedCodePage = { tree: CodePageTree; codeId: string; csrf: string | null; layout?: "plain" };
export type CodePageHostingContext = AuthContext & { Variables: { hostedCodePage: HostedCodePage } };
/**
 * Hosting validates the description before this final SSR handler. Only the tree is sent to the island. A page renders
 * inside the Cloud layout, signed in or not, like Core's own pages; a route declared with `layout: "plain"` renders
 * the page alone. Every variant carries the feat/code label outside the tree.
 */
export const codePageHandlers = ssr<CodePageHostingContext>((context) => {
  const { layout, ...page } = context.get("hostedCodePage");
  context.get("page").title = page.tree.title;
  const view = () => <CodePageHost {...page} locale={getLocale(context)} timeZone={getTimeZone(context)} />;
  return () =>
    layout === "plain" ? (
      <MinimalLayout c={context} preferences={false}>
        <main>{view()}</main>
      </MinimalLayout>
    ) : (
      <Layout c={context} title={page.tree.title} fullWidth>
        {/* The app card every app has. No head row: the page shows its own title. No sidebar until Code declares
            navigation. Main scrolls, so the feat/code label sticks to the card's bottom edge. */}
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1" resizable={false} head={false}>
          <AppWorkspace.Content>
            <AppWorkspace.Main>{view()}</AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    );
});
