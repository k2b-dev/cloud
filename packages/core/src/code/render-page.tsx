import type { CodePageTree } from "@k2b/cloud/code";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import CodePageTreeView from "./PageTree.island";

export type CodePageHostingContext = AuthContext & { Variables: { hostedCodePage: { tree: CodePageTree; codeId: string; csrf: string } } };
/** Hosting validates the description before this final SSR handler. Only the tree is sent to the island. */
export const codePageHandlers = ssr<CodePageHostingContext>((context) => {
  const page = context.get("hostedCodePage");
  context.get("page").title = page.tree.title;
  return () => (
    <MinimalLayout c={context} preferences={false}>
      <CodePageTreeView {...page} locale={getLocale(context)} />
    </MinimalLayout>
  );
});
