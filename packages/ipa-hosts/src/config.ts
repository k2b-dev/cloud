import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "ipa-hosts",
  name: "Hosts",
  icon: "ti ti-server",
  description: "Manage FreeIPA hosts, hostgroups, and mirrored host membership data.",
  presentation: {
    baseLocale: "en",
    translations: { de: { description: "FreeIPA-Hosts, Hostgruppen und gespiegelte Mitgliedschaften verwalten." } },
  },
  appearance: { accent: "#0e7490", background: { from: "#06b6d4", to: "#14b8a6", angle: 135 } },
  basePath: "/admin/ipa-hosts",
  baseUrl: "http://app-ipa-hosts:3000",
  adminHref: "/admin/ipa-hosts",
  widgets: [{ id: "sync", path: "/api/ipa-hosts/widget/sync" }],
  openapi: "/api/ipa-hosts/openapi.json",
  routes: ["/api/ipa-hosts", "/admin/ipa-hosts", "/public/ipa-hosts"],
});

export const { ssr, plugin } = app;
