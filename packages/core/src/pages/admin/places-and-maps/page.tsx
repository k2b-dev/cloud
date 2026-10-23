import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { geoAdmin } from "@k2b/cloud/services/geo/admin";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { placesAndMapsMessages } from "./messages";
import PlacesAndMaps from "./PlacesAndMaps.island";

export default ssr<AuthContext>(async (c) => {
  const t = placesAndMapsMessages.resolve([getLocale(c)]).t;
  const user = c.get("user");
  // Each part shows its own error with a retry when it cannot be read; the page still renders.
  const [status, usage, documentationBase] = await Promise.all([
    geoAdmin.status(user).catch(() => null),
    geoAdmin.usage(user).catch(() => null),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="flex min-h-0 flex-1 flex-col">
        <PlacesAndMaps initial={{ status, usage, actorId: user.id }} documentationBase={documentationBase} />
      </div>
    </AdminLayout>
  );
});
