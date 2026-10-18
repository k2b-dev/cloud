import { defineApp } from "@k2b/cloud";
import { closePanel, openPanel } from "@k2b/cloud/browser/panel";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { PanelLayout } from "@k2b/cloud/ssr";
import { Hono } from "hono";

const inventoryApp = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Track stock",
  baseUrl: "http://inventory:3000",
  routes: ["/app/inventory", "/api/inventory"],
  panel: {
    href: "/app/inventory/panel",
    label: "Stock lookup",
    icon: "ti ti-box",
    requiresRoles: ["user"],
  },
});

const { ssr } = inventoryApp;

const StockLookup = () => <p>Search stock</p>;

const panelPage = ssr<AuthContext>((c) => () => (
  <PanelLayout c={c} title="Stock lookup">
    <StockLookup />
  </PanelLayout>
));

export const inventoryPanelRoutes = new Hono<AuthContext>().get("/panel", auth.requireRole("user", ssr.access), ...panelPage);

export function lookUpBolts(): void {
  const accepted = openPanel("inventory", { search: "q=bolts" });
  if (!accepted) window.location.assign("/app/inventory");
}

export function finishLookup(): void {
  closePanel();
}
