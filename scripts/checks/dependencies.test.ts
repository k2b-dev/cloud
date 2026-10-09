import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { rule } from "./dependencies";

type Workspace = {
  catalog?: Record<string, string>;
  rootDev?: Record<string, string>;
  overrides?: Record<string, string>;
  published?: Record<string, string>;
  peers?: Record<string, string>;
  lock?: Record<string, string>;
};

/** Runs the rule on a workspace with one published package (`@k2b/lib` 1.2.0) and one private app (`@k2b/app`). */
const findings = async ({
  catalog = { hono: "4.13.9" },
  rootDev = {},
  overrides = {},
  published = {},
  peers = {},
  lock = {},
}: Workspace) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-dependencies-"));
  const json = (path: string, value: unknown) => writeFile(join(root, path), JSON.stringify(value));
  try {
    await mkdir(join(root, "packages/lib"), { recursive: true });
    await mkdir(join(root, "packages/app"), { recursive: true });
    await json("package.json", {
      private: true,
      workspaces: { packages: ["packages/lib", "packages/app"], catalog },
      devDependencies: rootDev,
      overrides,
      trustedDependencies: [],
    });
    await json("packages/lib/package.json", { name: "@k2b/lib", version: "1.2.0", dependencies: published });
    await json("packages/app/package.json", {
      name: "@k2b/app",
      private: true,
      dependencies: { hono: "catalog:" },
      peerDependencies: peers,
    });
    const packages = Object.fromEntries(Object.entries(lock).map(([path, id]) => [path, [id, "", {}, "sha512-x"]]));
    await writeFile(join(root, "bun.lock"), `{\n  "lockfileVersion": 1,\n  "packages": ${JSON.stringify(packages)},\n}\n`);
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}: ${finding.message}`).sort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts concrete pins and one resolved copy that match the catalog", async () => {
  expect(
    await findings({
      rootDev: { hono: "4.13.9" },
      overrides: { hono: "4.13.9" },
      published: { hono: "4.13.9" },
      lock: { hono: "hono@4.13.9", "some-dependency/hono": "hono@4.12.0" },
    }),
  ).toEqual([]);
});

test("reports concrete pins that drifted from the catalog", async () => {
  expect(
    await findings({
      rootDev: { hono: "4.13.8" },
      overrides: { hono: "4.13.7" },
      published: { hono: "4.13.10" },
      lock: { hono: "hono@4.13.9" },
    }),
  ).toEqual([
    "package.json: devDependencies.hono is 4.13.8 but the root catalog has hono 4.13.9; set both to one version and run bun install",
    "package.json: overrides.hono is 4.13.7 but the root catalog has hono 4.13.9; set both to one version and run bun install",
    "packages/lib/package.json: dependencies.hono is 4.13.10 but the root catalog has hono 4.13.9; set both to one version and run bun install",
  ]);
});

test("reports a second copy of a catalog dependency installed for a workspace package", async () => {
  expect(await findings({ lock: { hono: "hono@4.13.10", "@k2b/app/hono": "hono@4.13.9" } })).toEqual([
    "bun.lock: workspace packages resolve hono to 4.13.10 and 4.13.9 but the root catalog has 4.13.9; set the catalog and its concrete pins to one version and run bun install",
  ]);
});

test("reports a peer range that excludes the workspace version of that package", async () => {
  expect(await findings({ peers: { "@k2b/lib": "^1.1.0" } })).toEqual([]);
  expect(await findings({ peers: { "@k2b/lib": "^1.0.0 <1.2.0" } })).toEqual([
    "packages/app/package.json: peerDependencies.@k2b/lib is ^1.0.0 <1.2.0 but the workspace has @k2b/lib 1.2.0; widen the range",
  ]);
});
