import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import Credentials from "./Credentials.island";
import { credentialMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const t = credentialMessages.resolve([getLocale(c)]).t;
  const apps = getLocalizedRuntimeContext(c)
    .apps.map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const initial = await serviceAccountCredentials.listOverview({
    pagination: { page: 1, perPage: 20 },
    filter: { serviceAccountKind: "resource_bound", resourceType: "cloud.app" },
  });
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <Credentials apps={apps} initial={initial} />
      </div>
    </AdminLayout>
  );
});
