import { defineApp } from "@k2b/cloud";

/**
 * The installable mobile app (preview). The shell owns the manifest scope `/pwa/`: the welcome and pairing page,
 * Start, Settings, the offline page, the manifest and the service worker. Applications add their own pages below
 * `/pwa/<app-id>`; Core serves the phone's identity endpoints below `/pwa/_auth`.
 */
export const app = defineApp({
  id: "pwa",
  name: "Mobile app",
  icon: "ti ti-device-mobile",
  description: "The installable phone app of this Cloud.",
  presentation: {
    baseLocale: "en",
    translations: { de: { name: "Mobile App", description: "Die installierbare Handy-App dieser Cloud." } },
  },
  basePath: "/pwa",
  baseUrl: "http://app-pwa:3000",
  routes: ["/pwa", "/public/pwa"],
});

export const { ssr, plugin } = app;
