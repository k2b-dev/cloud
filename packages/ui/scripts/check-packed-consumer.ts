import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "k2b-ui-packed-consumer-"));

const run = (cmd: string[], cwd: string, env = process.env): string => {
  const result = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode})\n${stdout}${stderr}`);
  }
  return stdout;
};

try {
  const packDir = join(temporaryRoot, "pack");
  const unpackDir = join(temporaryRoot, "unpacked");
  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(unpackDir, { recursive: true });
  mkdirSync(join(consumer, "node_modules", "@k2b"), { recursive: true });

  const npm = Bun.which("npm");
  const tar = Bun.which("tar");
  if (!npm || !tar) throw new Error("npm and tar are required for the packed-consumer smoke");

  const packed = JSON.parse(
    run([npm, "pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", packDir], packageRoot),
  ) as Array<{ filename: string }>;
  const archive = join(packDir, packed[0]?.filename ?? "");
  run([tar, "-xzf", archive, "-C", unpackDir], packageRoot);

  const extractedPackage = join(unpackDir, "package");
  const forbiddenPackedFiles = [
    "src/index.ts",
    "src/styles/css-contract-test-helpers.ts",
    "dist/types/styles/css-contract-test-helpers.d.ts",
  ];
  for (const file of forbiddenPackedFiles) {
    if (existsSync(join(extractedPackage, file))) {
      throw new Error(`packed @k2b/ui must not contain test-only helper: ${file}`);
    }
  }

  const installedUi = join(consumer, "node_modules", "@k2b", "ui");
  renameSync(extractedPackage, installedUi);
  if (lstatSync(installedUi).isSymbolicLink()) {
    throw new Error("packed @k2b/ui must be a physical extracted package, not a workspace symlink");
  }
  if (!realpathSync(installedUi).startsWith(realpathSync(temporaryRoot))) {
    throw new Error("packed @k2b/ui resolved outside the isolated consumer");
  }

  for (const file of ["LICENSE", "dist/licenses/ibm-plex-sans.txt", "dist/licenses/ibm-plex-mono.txt", "dist/licenses/tabler-icons.txt"]) {
    if (!(await Bun.file(join(installedUi, file)).text()).trim()) throw new Error(`missing packed license: ${file}`);
  }
  const manifest = await Bun.file(join(installedUi, "package.json")).json();
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
    }),
  );
  run([process.execPath, "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"], consumer);

  const serverSmoke = `
    const resolved = import.meta.resolve("@k2b/ui");
    if (!resolved.includes("/node_modules/@k2b/ui/dist/ssr/index.js")) {
      throw new Error("public root did not resolve to packed dist/ssr/index.js: " + resolved);
    }
    const ui = await import("@k2b/ui");
    const required = ["Button", "Chart", "DatePicker", "Panes", "createPanesLayout", "prompts"];
    const missing = required.filter((name) => ui[name] === undefined);
    if (missing.length) throw new Error("missing representative exports: " + missing.join(", "));
    const { renderToString } = await import("solid-js/web");
    const html = renderToString(() => ui.Button({ children: "Packed button" }));
    if (!html.includes("Packed button")) throw new Error("packed SSR component did not render");
  `;
  for (const nodeEnv of ["development", "production"]) {
    run([process.execPath, "--no-install", "-e", serverSmoke], consumer, { ...process.env, NODE_ENV: nodeEnv });
  }

  const browserSmoke = `
    const resolved = import.meta.resolve("@k2b/ui");
    if (!resolved.includes("/node_modules/@k2b/ui/dist/browser/index.js")) {
      throw new Error("browser root did not resolve to packed dist/browser/index.js: " + resolved);
    }
  `;
  run([process.execPath, "--no-install", "--conditions=browser", "-e", browserSmoke], consumer);

  const globalStyles = import.meta.resolve("@k2b/ui/global.css", join(consumer, "index.ts"));
  if (!globalStyles.includes("/node_modules/@k2b/ui/dist/global.css")) {
    throw new Error(`global stylesheet did not resolve from packed dist: ${globalStyles}`);
  }
  const cssEntry = join(consumer, "global.css");
  const cssOut = join(consumer, "css-dist");
  await Bun.write(cssEntry, '@import "@k2b/ui/global.css";\n');
  const cssBuild = await Bun.build({ entrypoints: [cssEntry], outdir: cssOut });
  if (!cssBuild.success) {
    throw new Error(`packed global stylesheet build failed\n${cssBuild.logs.join("\n")}`);
  }
  const cssOutput = await Bun.file(join(cssOut, "global.css")).text();
  for (const [label, pattern] of [
    ["UI scope", /\.k2b-ui/],
    ["IBM Plex preset", /IBM Plex Sans/],
    ["Tabler preset", /font-family:\s*tabler-icons/],
  ] as const) {
    if (!pattern.test(cssOutput)) throw new Error(`packed global stylesheet is missing ${label}`);
  }

  const browserEntry = join(consumer, "browser-entry.ts");
  const browserOut = join(consumer, "browser-dist");
  await Bun.write(browserEntry, 'export { Button, DatePicker } from "@k2b/ui";\n');
  const browserBuild = await Bun.build({
    entrypoints: [browserEntry],
    outdir: browserOut,
    target: "browser",
    format: "esm",
    external: ["@k2b/ssr", "@k2b/ssr/*", "@k2b/stdlib", "@k2b/stdlib/*", "marked", "solid-js", "solid-js/*"],
  });
  if (!browserBuild.success) {
    throw new Error(`packed browser build failed\n${browserBuild.logs.join("\n")}`);
  }
  const browserOutput = await Bun.file(join(browserOut, "browser-entry.js")).text();
  if (browserOutput.includes("react/jsx-runtime")) {
    throw new Error("packed browser build still requires a React JSX transform");
  }
  if (browserOutput.length > 100_000) {
    throw new Error(`packed Button + DatePicker browser build is too large: ${browserOutput.length} bytes`);
  }
  for (const unusedFamily of ["reconcilePanesLayout", "FileBrowserPanel", "ChatComposer"]) {
    if (browserOutput.includes(unusedFamily)) {
      throw new Error(`packed browser build retained unused ${unusedFamily} code`);
    }
  }

  console.log(
    `Packed @k2b/ui imports and renders via SSR; global CSS bundles; browser tree-shaking produced ${browserOutput.length} bytes`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
