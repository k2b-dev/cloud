import { settings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { app } from "./config";
import { setupDomain } from "./domain";
import { createExamplePwa, type ExamplePwa } from "./platform";
import { createExampleRouter } from "./routes";

let pwa: ExamplePwa | undefined;
const router = createExampleRouter(() => {
  if (!pwa) throw new Error("App-PWA setup has not completed");
  return pwa;
});
export default await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: async () => {
      // The stored app.url wins; APP_URL is Cloud's existing bootstrap/fallback.
      // Never trust Host, Forwarded or the upstream request origin.
      const publicOrigin = publicCloudOrigin(await settings.get<string>("app.url"));
      pwa = createExamplePwa(publicOrigin);
      await setupDomain();
      await pwa.setup();
    },
  },
});
