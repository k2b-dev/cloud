import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rule } from "./network-guard";

const lines = async (source: string, file = "packages/demo/src/outbound.ts") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-network-guard-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/pulse"] } }));
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => finding.line);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports every way an application reaches the system resolver", async () => {
  expect(
    await lines(
      [
        'import { lookup } from "node:dns/promises";',
        'import * as resolver from "node:dns/promises";',
        'import dns from "node:dns";',
        'import { promises as dnsPromises } from "dns";',
        'import { resolveSrv, lookup as find } from "node:dns/promises";',
        'const late = await import("node:dns");',
        'const legacy = require("dns");',
        'await Bun.dns.lookup("example.com");',
        'import { dns, serve } from "bun";',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("allows record lookups that return no address to connect to", async () => {
  expect(
    await lines(
      [
        'import { resolveSrv } from "node:dns/promises";',
        'import { resolveMx as mx, resolveTxt } from "dns";',
        'import type { LookupAddress } from "node:dns";',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("requires agent: false in the same request as a pinned lookup on node:http", async () => {
  const request = (agent: string) =>
    ['import { request } from "node:https";', `request({ lookup: pinnedNetworkLookup(addresses),${agent} });`].join("\n");
  expect(await lines(request(""))).toEqual([2]);
  expect(await lines(request(" agent: false"))).toEqual([]);
  expect(
    await lines(
      [
        'import { request } from "node:http";',
        "request({ lookup: pinnedNetworkLookup(first), agent: false });",
        ...Array.from({ length: 8 }, () => "// other work"),
        "request({ lookup: pinnedNetworkLookup(second) });",
        'import { pinnedNetworkLookup as pin } from "@k2b/cloud/services/network-security";',
      ].join("\n"),
    ),
  ).toEqual([12, 11]);
});

test("keeps fetch() away from files that check hosts with the platform guard", async () => {
  expect(
    await lines(
      [
        'import { resolvePublicNetworkAddresses } from "@k2b/cloud/services/network-security";',
        "await resolvePublicNetworkAddresses(url.hostname);",
        "await fetch(url);",
        "await client.fetch(range);",
      ].join("\n"),
    ),
  ).toEqual([3]);
  expect(await lines("await fetch(apiUrl);")).toEqual([]);
});

test("Pulse server fetch requires its guarded transport; browser fetch stays allowed", async () => {
  expect(await lines("await fetch(url);", "packages/pulse/src/service/x.ts")).toEqual([1]);
  expect(await lines("await fetch(url);", "packages/pulse/src/frontend/client.ts")).toEqual([]);
  expect(await lines("await fetch(url);", "packages/pulse/src/widget.tsx")).toEqual([]);
  expect(await lines("await fetch(url);", "packages/pulse/src/cli/client.ts")).toEqual([]);
});

test("reports qualified global fetch in Pulse server code but allows application methods", async () => {
  const source = [
    "await Bun.fetch(url);",
    "await globalThis.fetch(url);",
    "await self.fetch(url);",
    "await app.fetch(url);",
    "await client.fetch(url);",
  ].join("\n");
  expect(await lines(source, "packages/pulse/src/service/x.ts")).toEqual([1, 2, 3]);
  expect(await lines(source)).toEqual([]);
});

test("requires a pinned lookup for node:http imports only in Pulse server code", async () => {
  const source = 'import { request } from "node:http";';
  expect(await lines(source, "packages/pulse/src/service/x.ts")).toEqual([1]);
  expect(
    await lines(`${source}\nrequest({ lookup: pinnedNetworkLookup(addresses), agent: false });`, "packages/pulse/src/service/x.ts"),
  ).toEqual([]);
  expect(await lines(source, "packages/demo/src/outbound.ts")).toEqual([]);
});
