import type { AuthContext } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import HealthWebhooksPanel from "../../frontend/HealthWebhooksButton.island";

export default ssr<AuthContext>(async (c) => {
  return () => (
    <AdminLayout c={c} title="Webhooks">
      <div class="app-rows">
        <HealthWebhooksPanel />
      </div>
    </AdminLayout>
  );
});
