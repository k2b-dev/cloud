import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "faq",
  name: "FAQ",
  icon: "ti ti-help-circle",
  description: "Frequently asked questions and public help content.",
  presentation: {
    baseLocale: "en",
    translations: { de: { description: "Häufig gestellte Fragen und öffentliche Hilfeinhalte." } },
  },
  appearance: { accent: "#b45309", background: { from: "#f59e0b" } },
  basePath: "/faq",
  baseUrl: "http://app-faq:3000",
  adminHref: "/admin/faq",
  nav: {
    // Hidden from nav rail; the public link is in the legal-links footer.
    href: "/faq",
    section: "hidden",
  },
  legalLinks: [{ label: "FAQ", href: "/faq", icon: "ti ti-help-circle" }],
  openapi: "/api/faq/openapi.json",
  // Top-level `/faq` for the public help page (linked from login footer).
  routes: ["/faq", "/api/faq", "/admin/faq", "/public/faq"],
});

export const { ssr, plugin } = app;
