import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { ssr } from "../../../config";
import Credentials from "./Credentials.island";
import { credentialMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const t = credentialMessages.resolve([getLocale(c)]).t;
  const apps = getLocalizedRuntimeContext(c)
    .apps.map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const appId = apps.find(({ id }) => id === c.req.query("app"))?.id ?? apps[0]?.id ?? "";
  const initial = appId
    ? await serviceAccountCredentials.listOverview({
        pagination: { page: 1, perPage: 20 },
        filter: { serviceAccountKind: "resource_bound", appId, resourceType: "cloud.app", resourceId: appId },
      })
    : null;
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows mx-auto w-full max-w-4xl">
        <h1 class="text-base font-semibold text-primary">{t.title}</h1>
        <p class="text-sm text-dimmed">{t.description}</p>
        <Credentials apps={apps} appId={appId} initial={initial} />
      </div>
    </AdminLayout>
  );
});
