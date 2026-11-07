import { describe, expect, test } from "bun:test";
import { appAccess } from "../contracts/app-access";
import { defineApp } from "./define-app";
import { inventory, publishedEntry } from "./define-app.test-fixture";
import { kiosk } from "./installable.test-fixture";
import { asAppRegistryEntry, validateAppRegistryEntry } from "./registry-validation";
import { buildRuntimeFromRegistry } from "./runtime-context";

describe("defineApp installable public declaration and registry", () => {
  test("carries the standalone declaration explicitly, independently of pwa, without inventing route coverage", async () => {
    const options = { ...inventory, access: appAccess.signedIn(), installable: kiosk, pwa: {} };
    const app = defineApp(options);
    expect(app.meta.installable).toEqual(kiosk);
    expect(app.meta.pwa?.href).toBe("/pwa/inventory");
    expect(app.meta.routes).toEqual([...inventory.routes, "/pwa/inventory"]);
    const entry = await publishedEntry(options, async (server) => {
      const response = await server.fetch(new Request(`http://app.test${kiosk.path}manifest.webmanifest`));
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(kiosk.path);
      expect((await server.fetch(new Request(`http://app.test${kiosk.path}sw.js`))).headers.get("Content-Type")).toContain("javascript");
    });
    expect(entry.installable).toEqual(kiosk);
    expect(validateAppRegistryEntry(entry)).toBeNull();
    expect(buildRuntimeFromRegistry([entry]).apps[0]?.installable).toEqual(kiosk);
    // Declaration is copied, including its nested theme; later source mutation cannot change the contract.
    const mutable = structuredClone(kiosk);
    const isolated = defineApp({ ...inventory, installable: mutable });
    mutable.themeColor.light = "#ffffff";
    expect(isolated.meta.installable?.themeColor.light).toBe("#fafafa");
  });

  test("invalid or uncovered declarations fail at definition and at the registry reader; old records remain valid", () => {
    const entry = { ...inventory, installable: kiosk };
    expect(asAppRegistryEntry(inventory)?.installable).toBeUndefined();
    for (const installable of [{ ...kiosk, path: "/app/other/counter/" }, { ...kiosk, display: "browser" }, [kiosk], null]) {
      expect(validateAppRegistryEntry({ ...entry, installable })).toContain("installable");
      expect(asAppRegistryEntry({ ...entry, installable })).toBeNull();
    }
    expect(() => defineApp({ ...inventory, routes: ["/"], installable: kiosk })).toThrow("invalid installable");
    expect(validateAppRegistryEntry({ ...entry, routes: ["/"] })).toContain("installable");
  });
});
