import { expect, test } from "bun:test";
import type { AppPanel } from "../contracts/app";
import { defineApp } from "./define-app";
import { inventory, publishedEntry } from "./define-app.test-fixture";
import { validateAppRegistryEntry } from "./registry-validation";

const panel = { href: "/app/inventory/panel", label: "Inventory panel", icon: "ti ti-box", requiresRoles: ["user"] } satisfies AppPanel;

test("copies the panel declaration and publishes it in the registry", async () => {
  const app = defineApp({ ...inventory, panel });
  expect(app.meta.panel).toEqual(panel);
  expect(app.meta.panel).not.toBe(panel);
  expect(app.meta.panel?.requiresRoles).not.toBe(panel.requiresRoles);
  const entry = await publishedEntry({ ...inventory, panel });
  expect(entry.panel).toEqual(panel);
  expect(validateAppRegistryEntry(entry)).toBeNull();
  expect(defineApp(inventory).meta.panel).toBeUndefined();
});

test("rejects a panel route outside the app, a foreign origin or escaping dot segments", () => {
  for (const href of [
    "/elsewhere",
    "//host/x",
    "https://host/app/inventory/panel",
    "/app/inventory/../../other",
    "/app/inventory/%2e%2e/other",
    "/app/inventory-other/panel",
  ]) {
    expect(() => defineApp({ ...inventory, panel: { ...panel, href } })).toThrow(`App "inventory" declares panel.href "${href}"`);
  }
});

test("rejects empty panel presentation", () => {
  for (const field of ["label", "icon"] as const) {
    for (const value of ["", "  "])
      expect(() => defineApp({ ...inventory, panel: { ...panel, [field]: value } })).toThrow(`panel.${field}`);
  }
});

test("validates untyped declarations at startup", () => {
  for (const [field, values] of [
    ["label", [null, 1]],
    ["icon", [null, 1]],
    ["requiresRoles", ["user", [1], null]],
  ] as const) {
    for (const value of values) {
      const options = { ...inventory, panel: { ...panel } };
      Reflect.set(options.panel, field, value);
      expect(() => defineApp(options)).toThrow(`panel.${field}`);
    }
  }
});
