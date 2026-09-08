import { defineApp } from "@valentinkolb/cloud";
import { Hono } from "hono";
import { inventoryCapabilities } from "./platform-capabilities";

const app = defineApp({
  id: "inventory",
  name: "Inventory",
  description: "Track inventory items.",
  icon: "ti ti-package",
  baseUrl: "http://app-inventory:3000",
  routes: ["/app/inventory"],
});

const router = new Hono().get("/app/inventory", (c) => c.html("<h1>Inventory</h1>"));

export default await app.start({
  capabilities: inventoryCapabilities,
  fetch: router.fetch,
});
