import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { checkPackedRuntime } from "./fixtures/packed-consumer-infrastructure";

// No inherited service credentials or repository aliases. Runtime acceptance uses
// fresh disposable infrastructure and the exact locally packed artifacts.
const root = resolve(import.meta.dir, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "cloud-packed-consumer-"));
const consumer = join(temporaryRoot, "consumer");
const cloudRoot = join(root, "packages/cloud");
const uiRoot = join(root, "packages/ui");
const cloudManifest = await Bun.file(join(cloudRoot, "package.json")).json();
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  APP_ID: "inventory",
  APP_DIR: consumer,
};

const run = async (label: string, cmd: string[], cwd: string): Promise<void> => {
  console.log(label);
  const child = Bun.spawn(cmd, { cwd, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${label} failed (${code})\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timer);
  }
};

try {
  await mkdir(join(consumer, "src"), { recursive: true });
  const cloudArchive = join(temporaryRoot, "cloud.tgz");
  const uiArchive = join(temporaryRoot, "ui.tgz");
  // The caller builds UI first. Never silently rebuild a shared local dist tree.
  if (!(await Bun.file(join(uiRoot, "dist/.build-complete")).exists())) {
    throw new Error("Build @k2b/ui before running this check: bun run --cwd packages/ui build");
  }
  const uiBuildTime = (await stat(join(uiRoot, "dist/.build-complete"))).mtimeMs;
  for (const [name, packageRoot, archive] of [
    ["Cloud", cloudRoot, cloudArchive],
    ["UI", uiRoot, uiArchive],
  ] as const) {
    await run(`Pack current ${name}`, [process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], packageRoot);
  }
  if ((await stat(join(uiRoot, "dist/.build-complete"))).mtimeMs !== uiBuildTime) {
    throw new Error("UI was rebuilt while packing; rerun after the build finishes");
  }
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "cloud-packed-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@k2b/cloud": cloudArchive,
          "@k2b/ui": uiArchive,
          ...cloudManifest.peerDependencies,
        },
        overrides: { "@k2b/ui": uiArchive },
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
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(consumer, "src/config.ts"),
    `import { defineApp } from "@k2b/cloud";
export const app = defineApp({
  id: "inventory", name: "Inventory", icon: "ti ti-packages",
  description: "Packed consumer smoke", baseUrl: process.env.CONSUMER_BASE_URL ?? "http://inventory:3000", routes: ["/api/inventory"],
});
`,
  );
  await Bun.write(
    join(consumer, "src/index.ts"),
    `import { Hono } from "hono";
import { app } from "./config";
const router = new Hono().get("/api/inventory/health", c => c.json({ app: app.meta.id, status: "ok" }));
export default await app.start({ fetch: router.fetch, port: Number(process.env.PORT ?? 3000) });
`,
  );
  await run(
    "Install in fresh external repository",
    [process.execPath, "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
    consumer,
  );
  for (const name of ["cloud", "ui"]) {
    const installed = await realpath(join(consumer, "node_modules/@k2b", name));
    if (!installed.startsWith(`${await realpath(temporaryRoot)}${sep}`)) {
      throw new Error(`${name} resolved outside the isolated consumer: ${installed}`);
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
  await run("Build with the installed Cloud production script", [process.execPath, "node_modules/@k2b/cloud/scripts/build.ts"], consumer);
  if ((await Bun.file(join(consumer, "dist/server.js")).size) === 0) throw new Error("Production server bundle is empty");
  await checkPackedRuntime(root, consumer, cleanEnv);
  // Gateway shares these scripts but provides its plugin without defineApp().
  await Bun.write(join(consumer, "src/config.ts"), await Bun.file(join(root, "packages/gateway/src/config.ts")).text());
  await Bun.write(join(consumer, "src/env.ts"), await Bun.file(join(root, "packages/gateway/src/env.ts")).text());
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
