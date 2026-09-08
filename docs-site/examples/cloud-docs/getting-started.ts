import { defineApp } from "@valentinkolb/cloud";
import { Hono } from "hono";

export const gettingStartedApp = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://app-inventory:3000",
  routes: ["/api/inventory"],
});

const router = new Hono().get("/api/inventory/health", (c) =>
  c.json({
    app: gettingStartedApp.meta.id,
    status: "ok",
  }),
);

export const gettingStartedServer = await gettingStartedApp.start({
  fetch: router.fetch,
});
