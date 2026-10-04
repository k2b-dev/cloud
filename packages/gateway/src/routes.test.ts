import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { buildAppRoutesDetailed } from "./routes";

const app = (id: string, routes: string[]): AppRegistryEntry => ({
  id,
  name: id,
  icon: "ti ti-box",
  description: id,
  baseUrl: `http://${id}:3000`,
  routes,
  startedAt: 0,
});

describe("reserved /pwa prefix", () => {
  test("routes the shell, Core's identity endpoints and each app's own part", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("pwa", ["/pwa", "/public/pwa"]),
      app("core", ["/", "/pwa/_auth/"]),
      app("spaces", ["/app/spaces", "/pwa/spaces"]),
    ]);
    expect(warnings).toEqual([]);
    expect(routes.filter((route) => route.prefix.startsWith("/pwa")).map(({ prefix, appId }) => [prefix, appId])).toEqual([
      ["/pwa", "pwa"],
      ["/pwa/_auth", "core"],
      ["/pwa/spaces", "spaces"],
    ]);
  });

  test("skips every other claim below /pwa with a warning", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("pwa", ["/pwa", "/pwa/pwa"]),
      app("core", ["/pwa/settings"]),
      app("spaces", ["/pwa/spaces", "/pwa/contacts", "/pwa/spaces/tasks", "/pwa/_auth", "/pwa/"]),
      app("offline", ["/pwa/offline"]),
      app("wiki", ["/pwax"]),
      app("spaces/tasks", ["/pwa/spaces/tasks"]),
    ]);
    expect(routes.map(({ prefix, appId }) => [prefix, appId])).toEqual([
      ["/pwa", "pwa"],
      ["/pwa/spaces", "spaces"],
      ["/pwax", "wiki"],
    ]);
    expect(warnings.map(({ appId, prefix, reason }) => [appId, prefix, reason])).toEqual([
      ["core", "/pwa/settings", "reserved_prefix"],
      ["offline", "/pwa/offline", "reserved_prefix"],
      ["pwa", "/pwa/pwa", "reserved_prefix"],
      ["spaces", "/pwa/contacts", "reserved_prefix"],
      ["spaces", "/pwa/spaces/tasks", "reserved_prefix"],
      ["spaces", "/pwa/_auth", "reserved_prefix"],
      ["spaces", "/pwa", "reserved_prefix"],
      ["spaces/tasks", "/pwa/spaces/tasks", "reserved_prefix"],
    ]);
  });

  test("checks prefixes with empty segments as the route trie reads them", () => {
    const { routes, warnings } = buildAppRoutesDetailed([
      app("core", ["/", "/pwa/_auth"]),
      app("pwa", ["/pwa"]),
      app("spaces", ["//pwa/_auth/session", "//pwa/settings", "/pwa//contacts/", "//pwa", "//app//spaces/"]),
    ]);
    expect(routes.map(({ prefix, appId }) => [prefix, appId])).toEqual([
      ["/", "core"],
      ["/app/spaces", "spaces"],
      ["/pwa", "pwa"],
      ["/pwa/_auth", "core"],
    ]);
    expect(warnings.map(({ appId, prefix, reason }) => [appId, prefix, reason])).toEqual([
      ["spaces", "/pwa/_auth/session", "reserved_prefix"],
      ["spaces", "/pwa/settings", "reserved_prefix"],
      ["spaces", "/pwa/contacts", "reserved_prefix"],
      ["spaces", "/pwa", "reserved_prefix"],
    ]);
  });

  test("reports a duplicate hidden behind empty segments", () => {
    const { routes, warnings } = buildAppRoutesDetailed([app("contacts", ["/app/contacts"]), app("spaces", ["//app/contacts"])]);
    expect(routes.map(({ prefix, appId }) => [prefix, appId])).toEqual([["/app/contacts", "contacts"]]);
    expect(warnings.map(({ appId, prefix, reason }) => [appId, prefix, reason])).toEqual([["spaces", "/app/contacts", "duplicate_prefix"]]);
  });
});
