import { defineApp } from "@k2b/cloud";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createUrlFilter, Layout, oneOf, page, text } from "@k2b/cloud/ssr";
import { StatusBadge } from "@k2b/ui";
import { Hono } from "hono";

export const inventoryRoutes = new Hono().get("/items/:id", (c) => c.json({ id: c.req.param("id"), name: "Example" }));

export type InventoryApi = typeof inventoryRoutes;

export const inventoryFilter = createUrlFilter("/app/inventory", {
  search: text("search"),
  status: oneOf("status", ["all", "low", "out"] as const, "all"),
  page: page(),
});

export const InventoryStatus = () => <StatusBadge tone="ok" label="Available" />;

const inventoryApp = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  basePath: "/app/inventory",
  baseUrl: "http://app-inventory:3000",
  routes: ["/api/inventory", "/app/inventory"],
});

const { ssr } = inventoryApp;

const inventoryPage = ssr<AuthContext>(async (c) => {
  const item = await Promise.resolve({
    id: c.req.query("selected") ?? "42",
    name: "Example",
  });
  c.get("page").title = "Inventory";

  return () => (
    <Layout c={c} title="Inventory">
      <main>
        <h1>{item.name}</h1>
      </main>
    </Layout>
  );
});

export const inventoryPageRoutes = new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.access), ...inventoryPage)
  .get("/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
