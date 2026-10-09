import { describe, expect, test } from "bun:test";
import { visiblePwaParts } from "../ssr/app-navigation";
import { type AppOptions, defineApp } from "./define-app";
import { inventory, person, publishedEntry } from "./define-app.fixture";
import { validateAppRegistryEntry } from "./registry-validation";
import { buildRuntimeFromRegistry } from "./runtime-context";

describe("defineApp({ pwa })", () => {
  test("adds /pwa/<id> to the routes and publishes the part for the mobile app's Start", async () => {
    const app = defineApp({ ...inventory, pwa: {} });
    expect(app.meta.routes).toEqual(["/api/inventory", "/app/inventory", "/pwa/inventory"]);
    expect(app.meta.pwa).toEqual({ href: "/pwa/inventory", requiresRoles: undefined });

    const entry = await publishedEntry({ ...inventory, pwa: {} });
    expect(entry.routes).toEqual(["/api/inventory", "/app/inventory", "/pwa/inventory"]);
    expect(entry.pwa).toEqual({ href: "/pwa/inventory" });
    expect(validateAppRegistryEntry(entry)).toBeNull();
    const { apps } = buildRuntimeFromRegistry([entry]);
    expect(visiblePwaParts(apps, person, "en").map((part) => [part.id, part.name, part.pwa.href])).toEqual([
      ["inventory", "Inventory", "/pwa/inventory"],
    ]);
  });

  test("places the part after CLI plugin routes and carries its roles", async () => {
    const options = {
      ...inventory,
      cli: { inventory: { module: "src/cli.ts", references: "src/cli-references" } },
      pwa: { requiresRoles: ["admin"] },
    } satisfies AppOptions;
    expect(defineApp(options).meta.routes).toEqual(["/api/inventory", "/app/inventory", "/cli/plugins/inventory", "/pwa/inventory"]);
    const entry = await publishedEntry(options);
    expect(entry.pwa).toEqual({ href: "/pwa/inventory", requiresRoles: ["admin"] });
    expect(validateAppRegistryEntry(entry)).toBeNull();
    expect(visiblePwaParts(buildRuntimeFromRegistry([entry]).apps, person, "en")).toEqual([]);
  });

  test("an app without pwa has no part", () => {
    const app = defineApp(inventory);
    expect(app.meta.pwa).toBeUndefined();
    expect(app.meta.routes).toEqual(inventory.routes);
  });

  test("routes below /pwa fail at declaration, except the shell's and Core's", () => {
    for (const route of [
      "/pwa/inventory",
      "/pwa/inventory/",
      "/pwa",
      "/pwa/",
      "/pwa/_auth",
      "/pwa/settings",
      "/pwa/spaces/tasks",
      "//pwa/_auth/session",
      "//pwa/settings",
      "//pwa",
      "/pwa//inventory",
      " //pwa/x/ ",
    ]) {
      expect(() => defineApp({ ...inventory, routes: [route] })).toThrow(`App "inventory" lists route "${route}"`);
    }
    expect(() => defineApp({ ...inventory, routes: ["/pwa/_auth"], pwa: {} })).toThrow("/pwa is reserved for the mobile app");
    expect(() => defineApp({ ...inventory, id: "pwa", routes: ["/pwa/_auth"] })).toThrow('App "pwa" lists route "/pwa/_auth"');
    expect(() => defineApp({ ...inventory, id: "core", routes: ["/pwa"] })).toThrow('App "core" lists route "/pwa"');
    // Prefixes outside the segment stay free.
    expect(defineApp({ ...inventory, routes: ["/pwax"] }).meta.routes).toEqual(["/pwax"]);
    expect(defineApp({ ...inventory, id: "pwa", routes: ["/pwa", "/public/pwa"] }).meta.routes).toEqual(["/pwa", "/public/pwa"]);
    expect(defineApp({ ...inventory, id: "core", routes: ["/", "/pwa/_auth"] }).meta.routes).toEqual(["/", "/pwa/_auth"]);
  });

  test("the shell's own ids and ids that are not plain path segments cannot declare a part", () => {
    for (const id of ["pwa", "settings", "offline", "_auth", "spaces/tasks", "Inventory"]) {
      expect(() => defineApp({ ...inventory, id, routes: [], pwa: {} })).toThrow(`App "${id}" cannot declare pwa`);
    }
  });
});
