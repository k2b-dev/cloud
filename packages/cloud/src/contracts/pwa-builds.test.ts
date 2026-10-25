import { expect, test } from "bun:test";
import { pwaBuild, pwaBuilds } from "./pwa-builds";
import type { AppRegistryEntry } from "./registry";

const app = (id: string, release: string, part = false): AppRegistryEntry => ({
  id,
  name: id,
  icon: "",
  description: "",
  baseUrl: `http://${id}:3000`,
  routes: [],
  runtime: { release, version: "1.0.0", syncVersion: "test" },
  ...(part ? { pwa: { href: `/pwa/${id}` } } : {}),
});

test("identifies independently released parts and the shared Core build, without unrelated applications", () => {
  expect(pwaBuilds([app("core", "core-a"), app("pwa", "shell-b"), app("inventory", "inv-c", true), app("mail", "mail-d")])).toEqual({
    core: "1.0.0:core-a",
    pwa: "1.0.0:shell-b",
    inventory: "1.0.0:inv-c",
  });
  expect(pwaBuild({ version: "1.0.0", release: "first" })).not.toBe(pwaBuild({ version: "1.0.0", release: "second" }));
  expect(pwaBuild(undefined)).toBeUndefined();
  expect(pwaBuilds([app("core", "development"), app("pwa", "local")])).toEqual({});
});
