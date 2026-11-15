import type { CodePageTree } from "@k2b/cloud/code";
import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { Layout, MinimalLayout } from "@k2b/cloud/ssr";
import { AppWorkspace } from "@k2b/ui";
import { ssr } from "../config";
import CodePageHost from "./PageHost";
import type { CodePageProvenanceSeed } from "./page-provenance-contracts";

export type HostedCodePage = {
  tree: CodePageTree;
  codeId: string;
  csrf: string | null;
  /** The label beside the tree, already reduced to this viewer. */
  provenance: CodePageProvenanceSeed;
  layout?: "plain";
};
export type CodePageHostingContext = AuthContext & {
  /** `settings` is the installation snapshot the settings middleware sets, as the layout reads it. */
  Variables: { hostedCodePage: HostedCodePage; settings?: { app?: { name?: string } } };
};
/**
 * Hosting validates the description before this final SSR handler. Only the tree is sent to the island. A page renders
 * inside the Cloud layout, signed in or not, like Core's own pages; a route declared with `layout: "plain"` renders
 * the page alone. Every variant carries the feat/code label outside the tree, from `provenance`.
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
      // The header names the page, or the Cloud when it has no title; never Core, which only hosts it.
      <Layout c={context} title={page.tree.title} headTitle="page" fullWidth>
        {/* The app card every app has. No head row: the page shows its own title. No sidebar until Code declares
            navigation. Main scrolls, so the footer with the feat/code label sticks to the card's bottom edge; its own
            fade replaces Main's, which would blend the label out with the content. */}
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1" resizable={false} head={false}>
          <AppWorkspace.Content>
            <AppWorkspace.Main class="code-page-main" scrollFade={false}>
              {view()}
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    );
});
