import { defineApp } from "@valentinkolb/cloud";
import { type AppContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  appearance: {
    accent: "#2563eb",
    background: {
      from: "#dbeafe",
      to: "#ecfeff",
      angle: 135,
    },
  },
  basePath: "/app/inventory",
  baseUrl: "http://app-inventory:3000",
  routes: ["/api/inventory", "/app/inventory"],
  nav: {
    href: "/app/inventory",
    section: "primary",
    requiresAuth: true,
  },
});

type InventoryAppContext = AppContext<typeof app>;

const apiRoutes = new Hono<InventoryAppContext>().get("/health", (c) =>
  c.json({
    app: app.meta.id,
    status: "ok",
  }),
);

const router = new Hono<InventoryAppContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/inventory", apiRoutes)
  .get("/app/inventory", (c) => c.html("<h1>Inventory</h1>"));

export default await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: async (cloud) => {
      cloud.logger("inventory").info("Setup complete");
    },
    start: async (cloud) => {
      cloud.logger("inventory").info("Application started");
    },
    stop: async (cloud) => {
      cloud.logger("inventory").info("Application stopped");
    },
  },
});
