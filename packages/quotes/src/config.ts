import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "quotes",
  name: "Quotes",
  icon: "ti ti-quote",
  description: "Show a quote that changes hourly.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { name: "Zitate", description: "Zeigt ein Zitat, das stündlich wechselt." },
    },
  },
  appearance: { accent: "#be185d", background: { from: "#ec4899", to: "#f59e0b", angle: 135 } },
  basePath: "/app/quotes",
  baseUrl: "http://app-quotes:3000",
  widgets: [{ id: "quote", path: "/api/quotes/widget/quote" }],
  openapi: "/api/quotes/openapi.json",
  // API-only app with no SSR pages. Exposes /api/quotes for the widget and
  // public quote-of-the-hour endpoint.
  routes: ["/api/quotes", "/public/quotes"],
});

export const { ssr, plugin } = app;
