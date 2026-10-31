import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "../index";
import admin from ".";
import { appDomainCommands } from "./app-domains";

const domain = {
  host: "site.example.test",
  redirectTo: null,
  createdAt: "2026-10-30T12:00:00.000Z",
  active: true,
  status: {
    checkedAt: "2026-10-30T12:00:00.000Z",
    dns: { ok: true, detail: "203.0.113.8" },
    certificate: { ok: false, detail: "Expired" },
    reachable: null,
  },
};
const invoke = async (
  args: string[],
  flags: CloudCliFlags = {},
  result: unknown = domain,
  mode: CloudCliOutputMode = "json",
  locale = "en",
) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args: ["apps", "domains", ...args],
    flags,
    options: { profile: "test", server: "https://cloud.example.test", token: "test", output: mode, locale },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Response.json(result);
    },
    readJson: (response) => response.json(),
    print: (value) => {
      output.push(value);
    },
    write: async () => {},
    error: () => {},
    json: (value) => {
      output.push(value);
    },
    jsonLine: (value) => {
      output.push(value);
    },
    table: (rows) => {
      output.push(rows);
    },
  };
  await defineCliCommands({ name: "admin", summary: "App domains", commands: appDomainCommands(locale) }).run(ctx);
  return { requests, output };
};

test("domain commands forward exact routes, redirects and structured responses", async () => {
  expect(await invoke(["ls", "site"], {}, { domains: [domain] })).toEqual({
    requests: [{ path: "/api/admin/apps/site/domains", method: "GET", body: null }],
    output: [{ domains: [domain] }],
  });
  expect((await invoke(["add", "site", "alias.example.test"], { "redirect-to": "site.example.test" })).requests[0]).toEqual({
    path: "/api/admin/apps/site/domains",
    method: "POST",
    body: { host: "alias.example.test", redirectTo: "site.example.test" },
  });
  expect((await invoke(["set", "site", "alias.example.test"], { "redirect-to": "site.example.test" })).requests[0]).toEqual({
    path: "/api/admin/apps/site/domains/alias.example.test",
    method: "PATCH",
    body: { redirectTo: "site.example.test" },
  });
  expect((await invoke(["set", "site", "alias.example.test"], { "no-redirect": true })).requests[0]?.body).toEqual({ redirectTo: null });
  expect((await invoke(["rm", "site", "site.example.test"], { yes: true }, { deleted: true })).requests[0]?.method).toBe("DELETE");
  for (const mode of ["json", "jsonl"] as const)
    expect((await invoke(["check", "site", "site.example.test"], {}, { status: domain.status }, mode)).output).toEqual([
      { status: domain.status },
    ]);
});
test("table output includes redirect, active state and all three check stages", async () => {
  const result = await invoke(["ls", "site"], {}, { domains: [domain] }, "text");
  expect(result.output).toEqual([[{ host: domain.host, redirect: "-", active: true, dns: "ok", certificate: "failed", reachable: "-" }]]);
  expect((await invoke(["check", "site", domain.host], {}, { status: domain.status }, "text")).output[0]).toEqual([
    { step: "dns", ok: true, detail: "203.0.113.8" },
    { step: "certificate", ok: false, detail: "Expired" },
    { step: "reachable", ok: "-", detail: "-" },
  ]);
});
test("removal requires confirmation and redirect set requires exactly one choice", async () => {
  await expect(invoke(["rm", "site", domain.host])).rejects.toThrow("--yes");
  await expect(invoke(["set", "site", domain.host])).rejects.toThrow("exactly one");
  await expect(invoke(["set", "site", domain.host], { "redirect-to": domain.host, "no-redirect": true })).rejects.toThrow("exactly one");
  const check = await invoke(["check", "site", domain.host], {}, { status: null }, "text", "de");
  expect(check.output[0]).toContain("Prüfung läuft");
  expect(admin.help?.("de")).toContain("App-Domains");
});
