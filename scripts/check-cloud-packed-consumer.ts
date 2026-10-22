import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { checkPackedRuntime } from "./fixtures/packed-consumer-infrastructure";
import { packedSiblings, resolvePackedConsumerPins } from "./fixtures/packed-consumer-pins";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--help" && arg !== "--release");
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Run with --help for usage.`);
if (args.includes("--help")) {
  console.log(`Usage: bun scripts/check-cloud-packed-consumer.ts [--release] [--help]

Pack @k2b/cloud, @k2b/ui and @k2b/ssr with npm, then install, typecheck,
build an island page and run it against disposable services outside the workspace.
Build UI first: bun run --cwd packages/ui build. Requires npm and Docker.

Default: use workspace tarballs for siblings, including unreleased changes.
--release: use exact sibling pins from npm when already published; otherwise
use a tarball only when its workspace version matches the pin. Registry failures
fail the check; release mode never falls back to workspace copies.
--help: print this usage and exit.`);
  process.exit(0);
}
const mode = args.includes("--release") ? "release" : "workspace";
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const versionManifest = z.object({ version: exactVersion });
const packOutput = z.array(z.object({ filename: z.string().regex(/^[^/\\]+\.tgz$/) })).length(1);
const registryMetadata = z.object({ versions: z.record(z.string(), z.object({})) });

const isPublished = async (name: string, version: string): Promise<boolean> => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2f")}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const metadata = registryMetadata.parse(await response.json());
    return Object.hasOwn(metadata.versions, version);
  } catch (cause) {
    throw new Error(
      `The npm registry is unreachable for ${name}@${version}. The release check resolves @k2b pins from npm like an app author and never falls back to workspace copies. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

// No inherited service credentials or repository aliases. Runtime acceptance uses
// fresh disposable infrastructure and the resolved release artifacts.
const root = resolve(import.meta.dir, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "cloud-packed-consumer-"));
const consumer = join(temporaryRoot, "consumer");
const cloudRoot = join(root, "packages/cloud");
const uiRoot = join(root, "packages/ui");
const ssrRoot = join(root, "packages/ssr");
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  APP_ID: "inventory",
  APP_DIR: consumer,
};

// The consumer lives outside the repository and does not inherit its bunfig.toml.
const releaseAgePolicy = async (): Promise<string> => {
  const policy = (await Bun.file(join(root, "bunfig.toml")).text()).match(/^minimumReleaseAge\w* = .+$/gm);
  if (!policy?.some((line) => line.startsWith("minimumReleaseAge ="))) {
    throw new Error("bunfig.toml no longer sets install.minimumReleaseAge");
  }
  const index = policy.findIndex((line) => line.startsWith("minimumReleaseAgeExcludes ="));
  const line = policy[index];
  if (!line) throw new Error("bunfig.toml no longer sets install.minimumReleaseAgeExcludes");
  const excludes = z.object({ minimumReleaseAgeExcludes: z.array(z.string()) }).parse(Bun.TOML.parse(line)).minimumReleaseAgeExcludes;
  // App authors have no repository age policy for newly published @k2b release pins.
  policy[index] = `minimumReleaseAgeExcludes = ${JSON.stringify([...new Set([...excludes, "@k2b/cloud", ...packedSiblings])])}`;
  return `[install]\n${policy.join("\n")}\n`;
};

const run = async (label: string, cmd: string[], cwd: string): Promise<string> => {
  console.log(label);
  const child = Bun.spawn(cmd, { cwd, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${label} failed (${code})\n${stdout}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
};

try {
  const cloudManifest = z
    .object({
      dependencies: z.object({ "@k2b/ui": exactVersion, "@k2b/ssr": exactVersion }),
      peerDependencies: z.record(z.string(), z.string()),
      devDependencies: z.object({ "@types/bun": z.string(), typescript: z.string() }),
    })
    .parse(await Bun.file(join(cloudRoot, "package.json")).json());
  const uiManifest = versionManifest.parse(await Bun.file(join(uiRoot, "package.json")).json());
  const ssrManifest = versionManifest.parse(await Bun.file(join(ssrRoot, "package.json")).json());
  await mkdir(join(consumer, "src"), { recursive: true });
  // The caller builds UI first. Never silently rebuild a shared local dist tree.
  if (!(await Bun.file(join(uiRoot, "dist/.build-complete")).exists())) {
    throw new Error("Build @k2b/ui before running this check: bun run --cwd packages/ui build");
  }
  const uiBuildTime = (await stat(join(uiRoot, "dist/.build-complete"))).mtimeMs;
  const pack = async (name: string, packageRoot: string): Promise<string> => {
    const output = await run(
      `Pack current ${name}`,
      ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
      packageRoot,
    );
    const [archive] = packOutput.parse(JSON.parse(output));
    if (!archive) throw new Error(`npm pack produced no archive for ${name}`);
    return join(temporaryRoot, archive.filename);
  };
  const cloudArchive = await pack("Cloud", cloudRoot);
  const uiArchive = await pack("UI", uiRoot);
  const ssrArchive = await pack("SSR", ssrRoot);
  if ((await stat(join(uiRoot, "dist/.build-complete"))).mtimeMs !== uiBuildTime) {
    throw new Error("UI was rebuilt while packing; rerun after the build finishes");
  }
  const pins = await resolvePackedConsumerPins({
    pins: cloudManifest.dependencies,
    workspaceVersions: { "@k2b/ui": uiManifest.version, "@k2b/ssr": ssrManifest.version },
    archives: { "@k2b/ui": uiArchive, "@k2b/ssr": ssrArchive },
    mode,
    isPublished,
  });
  for (const name of packedSiblings) {
    const pin = pins[name];
    const origin =
      pin.source === "npm"
        ? "npm (already published)"
        : `packed tarball (${mode === "release" ? "published by this release" : "workspace"})`;
    console.log(`${name}@${pin.pin} from ${origin}`);
  }
  const siblingSpecs = { "@k2b/ui": pins["@k2b/ui"].spec, "@k2b/ssr": pins["@k2b/ssr"].spec };
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "cloud-packed-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...cloudManifest.peerDependencies,
          "@k2b/cloud": cloudArchive,
          ...siblingSpecs,
        },
        overrides: siblingSpecs,
        devDependencies: {
          "@types/bun": cloudManifest.devDependencies["@types/bun"],
          typescript: cloudManifest.devDependencies.typescript,
        },
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.AsyncIterable"],
          target: "ESNext",
          module: "Preserve",
          moduleDetection: "force",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          jsx: "preserve",
          jsxImportSource: "solid-js",
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      },
      null,
      2,
    ),
  );
  await mkdir(join(consumer, "src/skills/inventory-counting/references"), { recursive: true });
  await Bun.write(
    join(consumer, "src/skills/inventory-counting/SKILL.md"),
    `---
name: inventory-counting
description: Count inventory on a shelf.
---

Count the shelf inventory using the Inventory application.
Read [Counting rules](references/counting.md) before reporting a total.
`,
  );
  await Bun.write(
    join(consumer, "src/skills/inventory-counting/references/counting.md"),
    "Count each item once and report missing labels.\n",
  );
  await Bun.write(
    join(consumer, "src/skills.ts"),
    `import { skill } from "@k2b/cloud";
import markdown from "./skills/inventory-counting/SKILL.md" with { type: "text" };
import counting from "./skills/inventory-counting/references/counting.md" with { type: "text" };
export const SKILLS = [skill({ markdown, references: { "references/counting.md": counting } })];
`,
  );
  await Bun.write(join(consumer, "src/markdown.d.ts"), 'declare module "*.md" { const text: string; export default text; }\n');
  // A third-party part of the mobile app: declared with pwa, served with PwaLayout behind ssr.pwaAccess.
  await Bun.write(
    join(consumer, "src/config.ts"),
    `import { defineApp } from "@k2b/cloud";
import { SKILLS } from "./skills";
export const app = defineApp({
  skills: SKILLS,
  id: "inventory", name: "Inventory", icon: "ti ti-packages", description: "Packed consumer smoke",
  basePath: "/pwa/inventory", baseUrl: process.env.CONSUMER_BASE_URL ?? "http://inventory:3000", routes: ["/api/inventory"], pwa: {},
});
`,
  );
  await Bun.write(
    join(consumer, "src/shelf-counter.island.tsx"),
    `import { Button } from "@k2b/ui";
import { createSignal } from "solid-js";
export default function ShelfCounter() {
  const [count, setCount] = createSignal(0);
  return <Button onClick={() => setCount(count() + 1)}>Count: {count()}</Button>;
}
`,
  );
  await Bun.write(
    join(consumer, "src/shelf.page.tsx"),
    `import type { AuthContext } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import { app } from "./config";
import ShelfCounter from "./shelf-counter.island.tsx";
export default app.ssr<AuthContext>((c) => () => (
  <PwaLayout c={c} title="Inventory">
    <p>Shelf A</p>
    <ShelfCounter />
  </PwaLayout>
));
`,
  );
  await Bun.write(
    join(consumer, "src/index.ts"),
    `import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { app } from "./config";
import shelfPage from "./shelf.page";
const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .get("/api/inventory/health", c => c.json({ app: app.meta.id, status: "ok" }))
  .get("/pwa/inventory", auth.requireRole("authenticated", app.ssr.pwaAccess), auth.requireUser(app.ssr.pwaAccess), ...shelfPage);
export default await app.start({ fetch: router.fetch, port: Number(process.env.PORT ?? 3000) });
`,
  );
  await Bun.write(join(consumer, "bunfig.toml"), await releaseAgePolicy());
  await run(
    "Install in fresh external repository",
    [process.execPath, "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
    consumer,
  );
  for (const name of ["@k2b/cloud", ...packedSiblings]) {
    const installed = await realpath(join(consumer, "node_modules", name));
    const pin = name === "@k2b/ui" || name === "@k2b/ssr" ? pins[name] : undefined;
    const isolatedRoot = pin?.source === "npm" ? join(consumer, "node_modules") : temporaryRoot;
    if (!installed.startsWith(`${await realpath(isolatedRoot)}${sep}`)) {
      throw new Error(`${name} resolved outside the isolated consumer: ${installed}`);
    }
    if (pin?.source === "npm") {
      const manifest = versionManifest.parse(await Bun.file(join(installed, "package.json")).json());
      if (manifest.version !== pin.pin) throw new Error(`${name} installed ${manifest.version}, expected npm pin ${pin.pin}`);
    }
  }
  if (!(await Bun.file(join(consumer, "node_modules/@k2b/ui/dist/types/index.d.ts")).exists())) {
    throw new Error("Packed UI is missing its public type entry; rebuild UI and rerun");
  }
  await Bun.write(join(consumer, "src/runtime-check.ts"), Bun.file(join(root, "scripts/fixtures/packed-consumer-runtime.ts")));
  await run(
    "Strict public-source typecheck",
    [process.execPath, "node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
    consumer,
  );
  await run(
    "Load the minimal app through the installed preload",
    [process.execPath, "--preload", "./node_modules/@k2b/cloud/scripts/preload.ts", "./src/config.ts"],
    consumer,
  );
  await Bun.write(
    join(consumer, "src/styles/app.css"),
    `@import "tailwindcss";
.packed-mixes {
  background: color-mix(in oklab, var(--x) 12%, var(--y));
  --mixed: color-mix(in oklab, var(--x) 20%, var(--y));
  border: 1px solid color-mix(in oklab, var(--x) 40%, var(--y));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--x) 30%, var(--y));
  background-image: linear-gradient(color-mix(in oklab, var(--x) 20%, var(--y)), color-mix(in oklab, var(--y) 60%, var(--x)));
  outline: 2px solid color-mix(in oklab, var(--x) 50%, var(--y)) !important;
}
.packed-utilities { @apply bg-(--x)/12 border-(--y)/40; }
`,
  );
  await run("Build with the installed Cloud production script", [process.execPath, "node_modules/@k2b/cloud/scripts/build.ts"], consumer);
  // SSR names island entries with the first 12 hex digits of the relative path's MD5.
  const islandId = new Bun.CryptoHasher("md5").update("src/shelf-counter.island.tsx").digest("hex").slice(0, 12);
  const islandBundle = Bun.file(join(consumer, "dist/_ssr", `${islandId}.js`));
  if (!(await islandBundle.exists()) || islandBundle.size === 0) {
    throw new Error(`Production build did not emit a hydration bundle for shelf-counter.island.tsx: dist/_ssr/${islandId}.js`);
  }
  if ((await Bun.file(join(consumer, "dist/server.js")).size) === 0) throw new Error("Production server bundle is empty");
  const appCss = (await Bun.file(join(consumer, "dist/public/inventory/app.css")).text()).replace(/\s+/g, " ").trim();
  for (const declaration of [
    "background: color-mix(in oklab, var(--x) 12%, var(--y));",
    "--mixed: color-mix(in oklab, var(--x) 20%, var(--y));",
    "border: 1px solid color-mix(in oklab, var(--x) 40%, var(--y));",
    "box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--x) 30%, var(--y));",
    "background-image: linear-gradient(color-mix(in oklab, var(--x) 20%, var(--y)), color-mix(in oklab, var(--y) 60%, var(--x)));",
    "outline: 2px solid color-mix(in oklab, var(--x) 50%, var(--y)) !important;",
    "background-color: color-mix(in oklab, var(--x) 12%, transparent);",
    "border-color: color-mix(in oklab, var(--y) 40%, transparent);",
  ]) {
    if (!appCss.includes(declaration)) throw new Error(`Packed app CSS lost a mixed declaration: ${declaration}`);
  }
  if (appCss.includes("@supports (color: color-mix(in lab, red, red))")) {
    throw new Error("Packed app CSS retained Tailwind's color-mix polyfill before Bun bundling");
  }
  await checkPackedRuntime(root, consumer, cleanEnv);
  // Gateway shares these scripts but provides its plugin without defineApp().
  // Copy config.ts with every local module it imports.
  for (const file of ["config.ts", "env.ts", "client-address.ts"]) {
    await Bun.write(join(consumer, "src", file), await Bun.file(join(root, "packages/gateway/src", file)).text());
  }
  await Bun.write(join(consumer, "src/index.ts"), `export default { fetch: () => new Response("ok") };\n`);
  await run(
    "Load plugin-only config through the installed preload",
    [process.execPath, "--preload", "./node_modules/@k2b/cloud/scripts/preload.ts", "./src/config.ts"],
    consumer,
  );
  await run("Build plugin-only config", [process.execPath, "node_modules/@k2b/cloud/scripts/build.ts"], consumer);
  if ((await Bun.file(join(consumer, "dist/server.js")).size) === 0) throw new Error("Plugin-only server bundle is empty");
  console.log(
    "Packed checkout installs, typechecks and builds without workspace aliases or extra transitive dependencies. Production runtime registration, HTTP and graceful shutdown pass against disposable services.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
