import { appAccess, defineApp } from "@k2b/cloud";

/**
 * The installable Cloud app (preview). The shell owns the manifest scope `/pwa/`: the welcome and pairing page,
 * Start, Settings, the offline page, the manifest and the service worker. Applications add their own pages below
 * `/pwa/<app-id>`; Core serves the phone's identity endpoints below `/pwa/_auth`.
 */
export const app = defineApp({
  id: "pwa",
  access: appAccess.signedIn({
    publicRoutes: ["/pwa", "/pwa/", "/pwa/manifest.webmanifest", "/pwa/sw.js"],
  }),
  name: "Cloud app",
  icon: "ti ti-device-mobile",
  description: "This Cloud as an app on your device.",
  presentation: {
    baseLocale: "en",
    translations: { de: { name: "Cloud-App", description: "Diese Cloud als App auf deinem Gerät." } },
  },
  basePath: "/pwa",
  baseUrl: "http://app-pwa:3000",
  routes: ["/pwa", "/public/pwa"],
});

export const { ssr, plugin } = app;
