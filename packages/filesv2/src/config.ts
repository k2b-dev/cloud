import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "filesv2",
  name: "Files v2",
  icon: "ti ti-folders",
  description: "Cloud and FreeIPA files with direct downloads.",
  presentation: { baseLocale: "en", translations: { de: { description: "Cloud- und FreeIPA-Dateien mit direkten Downloads." } } },
  basePath: "/app/filesv2",
  baseUrl: "http://app-filesv2:3000",
  adminHref: "/admin/filesv2",
  nav: { href: "/app/filesv2", match: "/app/filesv2", section: "primary", requiresAuth: true, requiresRoles: ["user"] },
  openapi: "/api/filesv2/openapi.json",
  routes: ["/api/filesv2", "/app/filesv2", "/admin/filesv2", "/public/filesv2", "/share/filesv2"],
  settings: {
    "filesv2.configuration": {
      kind: "secret",
      label: "Files configuration",
      default: "",
      description: "Managed through Files v2 administration. Contains the Filegate credential and both area configurations.",
      presentation: {
        translations: {
          de: {
            label: "Dateikonfiguration",
            description: "Wird in der Files-v2-Administration verwaltet. Enthält Filegate-Zugang und beide Dateibereiche.",
          },
        },
      },
    },
  },
});
export const { ssr, plugin } = app;
