import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "contacts",
  name: "Contacts",
  icon: "ti ti-address-book",
  description: "Business contact books with structured emails, phones, and postal addresses.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Kontakte",
        description: "Geschäftliche Kontaktbücher mit E-Mail-Adressen, Telefonnummern und Postanschriften.",
      },
    },
  },
  appearance: {
    accent: "#4f46e5",
    background: {
      from: "#6366f1",
      to: "#8b5cf6",
    },
  },
  basePath: "/app/contacts",
  baseUrl: "http://app-contacts:3000",
  adminHref: "/admin/contacts",
  nav: {
    href: "/app/contacts",
    match: "/app/contacts",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  openapi: "/api/contacts/openapi.json",
  routes: ["/api/contacts", "/app/contacts", "/admin/contacts", "/public/contacts"],
});

export const { ssr, plugin } = app;
