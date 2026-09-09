import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { AppOverview } from "@k2b/ui";
import { filesService } from "@/service";
import { ssr } from "../config";
import { filesMessages } from "./messages";

/**
 * Files index page - redirects to first accessible base
 */
export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);

  // Get all accessible bases
  const bases = await filesService.base.listResolved({ user });

  if (bases.length === 0) {
    return () => (
      <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.files }]}>
        <AppOverview title={t.files} subtitle={t.browse} icon="ti ti-folders">
          <AppOverview.Main title={t.storage} description={t.noStorageDescription}>
            <AppOverview.EmptyState title={t.noStorage} description={t.requestAccess} icon="ti ti-folder-off" />
          </AppOverview.Main>
        </AppOverview>
      </Layout>
    );
  }

  // Redirect to first base
  const firstBase = bases[0]!;
  const redirectUrl = firstBase.type === "home" ? "/app/files/home" : `/app/files/group/${firstBase.name}`;

  return c.redirect(redirectUrl, 302);
});
