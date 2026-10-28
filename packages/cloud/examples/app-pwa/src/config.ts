import { appAccess, defineApp } from "@k2b/cloud";
import { APP_ID, COUNTER_PATH, STAFF_PATH } from "./constants";

export const installable = {
  path: COUNTER_PATH,
  name: "Laden-iPad",
  shortName: "Laden-iPad",
  icon: "ti ti-signature",
  themeColor: { light: "#ffffff", dark: "#18181b" },
  display: "standalone",
} as const;
export const app = defineApp({
  id: APP_ID,
  name: "Besuchsbeispiel",
  icon: "ti ti-signature",
  description: "Ein Laden-iPad koppeln und fiktive Besuchsdokumente unterschreiben.",
  basePath: "/app/visit-demo",
  // The operator supplies this service name on the Cloud private network.
  baseUrl: "http://visit-demo:3000",
  routes: ["/app/visit-demo", "/api/visit-demo", "/public/visit-demo"],
  presentation: { baseLocale: "de", translations: {} },
  access: appAccess.noGuests({ publicRoutes: [COUNTER_PATH.slice(0, -1), COUNTER_PATH, `${COUNTER_PATH}*`] }),
  nav: { href: STAFF_PATH, match: "/app/visit-demo", section: "more", requiresAuth: true },
  installable,
});
export const { ssr, plugin } = app;
