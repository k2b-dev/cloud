import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guardedServerRoots, rule } from "./network-guard";

const findings = async (source: string, file = "packages/demo/src/outbound.ts", missing?: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-network-guard-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        workspaces: {
          packages: [
            "packages/demo",
            "packages/pulse",
            "packages/notebooks",
            "packages/cloud",
            "packages/assistant",
            "packages/gateway-ops",
          ],
        },
      }),
    );
    for (const guarded of guardedServerRoots) {
      if (guarded === missing) continue;
      const path = join(root, guarded);
      await mkdir(guarded.endsWith("/") ? path : dirname(path), { recursive: true });
      if (!guarded.endsWith("/")) await writeFile(path, "");
    }
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    return await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const lines = async (source: string, file?: string) => (await findings(source, file)).map((finding) => finding.line);

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

test("Notebooks server requests require the guard, including S3 SDK I/O", async () => {
  const file = "packages/notebooks/src/service/snapshots.ts";
  expect(await lines("new Bun.S3Client(options).write(key, body);", file)).toEqual([1]);
  expect(await lines("await fetch(url);", file)).toEqual([1]);
  for (const source of [
    "Bun.s3.write(key, body);",
    'import { s3 } from "bun";',
    'import { S3Client } from "bun";\nnew S3Client(options).file(key);',
    "await Bun.write(Bun.file(`s3://${bucket}/${key}`), body);",
    "await Bun.write(Bun.file(path, { endpoint, accessKeyId, secretAccessKey }), body);",
    "const { S3Client: Client } = Bun;\nnew Client(options).write(key, body);",
    'import * as bun from "bun";\nnew bun.S3Client(options).write(key, body);',
  ]) {
    expect((await lines(source, file)).length).toBeGreaterThan(0);
  }
  expect(
    await lines("new Bun.S3Client(options).presign(key);\nrequest({ lookup: pinnedNetworkLookup(addresses), agent: false });", file),
  ).toEqual([]);
  expect(
    await lines(
      'import { S3Client } from "bun";\nnew S3Client(options).presign(key);\nrequest({ lookup: pinnedNetworkLookup(addresses), agent: false });',
      file,
    ),
  ).toEqual([]);
  expect(
    await lines("new Bun.S3Client(options).write(key, body);\nrequest({ lookup: pinnedNetworkLookup(addresses), agent: false });", file),
  ).toEqual([1]);
});

for (const file of guardedServerRoots.filter((root) => root.endsWith(".ts"))) {
  test(`guards administrator endpoint ${file} without extending to its package`, async () => {
    expect(await lines("fetch(url);\nBun.fetch(url);\nglobalThis.fetch(url);", file)).toEqual([1, 2, 3]);
    expect(await lines("guardedFetch(url);", file)).toEqual([]);
    expect(await lines("fetch(url);", file.replace(/[^/]+$/, "other.ts"))).toEqual([]);
  });
}
test("the shared allowlisted transport must keep its pinned lookup on node:http", async () => {
  const file = "packages/cloud/src/services/allowed-network-fetch.ts";
  expect(await lines('import { request } from "node:http";\nrequest({ hostname, agent: false });', file)).toEqual([1]);
  expect(
    await lines('import { request } from "node:http";\nrequest({ lookup: pinnedNetworkLookup(addresses), agent: false });', file),
  ).toEqual([]);
});
for (const client of [
  "new ImapFlow(options)",
  "nodemailer.createTransport(options)",
  "createTransport(options)",
  "new SMTPConnection(options)",
]) {
  test(`requires a guard import for ${client}`, async () => {
    expect(await lines(client)).toEqual([1]);
    for (const path of [
      "@k2b/cloud/services/network-security",
      "../../services/network-security",
      "./network-security",
      "@k2b/cloud/services/outgoing-mail/resolve-host",
      "./resolve-host",
    ]) {
      expect(await lines(`import { guard } from "${path}";\n${client}`)).toEqual([]);
    }
    expect(await lines(client, "packages/demo/src/mail.test.ts")).toEqual([]);
  });
}
for (const missing of guardedServerRoots) {
  test(`reports missing guard coverage ${missing}`, async () => {
    const result = await findings("", "packages/demo/src/other.ts", missing);
    expect(result).toHaveLength(1);
    expect(result[0]?.file.endsWith(missing)).toBe(true);
    expect(result[0]?.message).toContain("no longer exists");
  });
}

test("current workspace mail clients and guarded endpoints satisfy the rule", async () => {
  const { fileURLToPath } = await import("node:url");
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
});

test("mail constructor coverage also includes workspace scripts", async () => {
  expect(await lines("new ImapFlow(options)", "scripts/imap.ts")).toEqual([1]);
  expect(
    await lines(
      'import { resolveMailHost } from "../packages/cloud/src/services/outgoing-mail/resolve-host";\nnew ImapFlow(options)',
      "scripts/imap.ts",
    ),
  ).toEqual([]);
});
