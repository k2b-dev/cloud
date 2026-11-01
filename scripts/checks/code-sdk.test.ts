import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { generateCodeSdk } from "../../packages/cloud/src/code";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
import { packageIds } from "../workspace";
import { declarationOf } from "./capability-presentation";

const workspaceRoot = resolve(import.meta.dir, "../..");
const manifests: CapabilityManifest[] = [];
for (const appId of packageIds(workspaceRoot)) {
  const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
  if (!declaration) continue;
  if (declaration instanceof Error) throw declaration;
  const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
  const definitions = loaded[declaration.exportName];
  if (!definitions) throw new Error(`${declaration.exportName} is not exported`);
  const manifest = compileCapabilities(appId, definitions).manifest;
  manifests.push(manifest);
  test(`Code SDK accepts the ${appId} capability manifest`, () => {
    expect(generateCodeSdk([manifest], { mode: "personal" }).manifest.apps).toHaveLength(1);
  });
}

test("Code SDK generation accepts the combined built-in capability catalog", () => {
  expect(manifests.length).toBeGreaterThan(0);
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  expect(sdk.manifest.apps).toHaveLength(manifests.length);
  expect(sdk.manifest.operations.length).toBeGreaterThan(0);
});

test("the combined catalog SDK loads and its declarations compile with tsgo", async () => {
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  const directory = await mkdtemp(join(tmpdir(), "cloud-code-c15-catalog-"));
  const runtime = join(directory, "sdk.mjs");
  const declarations = join(directory, "sdk.d.ts");
  try {
    await writeFile(runtime, sdk.runtime);
    await writeFile(declarations, sdk.declarations);
    const loaded = await import(runtime);
    for (const app of sdk.manifest.apps) expect(loaded[app.exportName].app().id).toBe(app.appId);
    const compiler = join(workspaceRoot, "node_modules/.bin/tsc");
    const proc = Bun.spawn([compiler, "--checkers", "1", "--ignoreConfig", "--strict", "--noEmit", "--target", "esnext", declarations], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await unlink(runtime);
    await unlink(declarations);
    await rmdir(directory);
  }
});
