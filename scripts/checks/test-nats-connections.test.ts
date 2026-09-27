import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./test-nats-connections";

const fixtureImport = 'import { natsServers } from "../../../scripts/fixtures/test-infra";\n';

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-nats-connections-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/example"] } }));
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts connectTestNats() and connections with their own credentials", async () => {
  expect(
    await findings({
      "packages/example/src/fixture.integration.test.ts":
        'import { connectTestNats } from "../../../scripts/fixtures/test-infra";\nconst connection = await connectTestNats({ ignoreClusterUpdates: true });\n',
      "packages/example/src/bounded.integration.test.ts":
        'import { connect } from "@nats-io/transport-node";\nawait connect({ servers: [bounded], user: "app", pass: "app" });\n',
      "packages/example/src/helper.ts": `${fixtureImport}import { connect, credsAuthenticator } from "@nats-io/transport-node";\nawait connect({\n  servers,\n  authenticator: credsAuthenticator(creds),\n});\n`,
      "packages/example/src/approval.test.ts": "await appApproval.connect({ issuer });\nawait Bun.connect({ hostname, port });\n",
    }),
  ).toEqual([]);
});

test("reports test code that connects to NATS without credentials", async () => {
  expect(
    (
      await findings({
        "packages/example/src/static.integration.test.ts":
          'import { connect } from "@nats-io/transport-node";\n\nconst connection = await connect({ servers: natsServers() });\n',
        "packages/example/src/dynamic.test.ts":
          'const { connect } = await import("@nats-io/transport-node");\nconst connection = await connect({\n  servers: natsServers(),\n});\n',
        "packages/example/src/helper.ts": `${fixtureImport}import { connect, type NatsConnection } from "@nats-io/transport-node";\nexport const open = () => connect({ servers: natsServers() });\n`,
        "tests/integration/root.integration.test.ts": 'import { connect } from "@nats-io/transport-node";\nawait connect({ servers });\n',
      })
    ).sort(),
  ).toEqual([
    "packages/example/src/dynamic.test.ts:2",
    "packages/example/src/helper.ts:3",
    "packages/example/src/static.integration.test.ts:3",
    "tests/integration/root.integration.test.ts:2",
  ]);
});

test("leaves application code alone", async () => {
  expect(
    await findings({
      "packages/example/src/runtime.ts":
        'import { connect } from "@nats-io/transport-node";\nawait connect({ servers: env.NATS_SERVERS });\n',
    }),
  ).toEqual([]);
});
