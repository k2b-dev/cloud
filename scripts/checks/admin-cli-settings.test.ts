import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./admin-cli-settings";

test("a new administrator setting cannot ship without a CLI setter", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-admin-cli-check-"));
  const dirs = [
    "packages",
    "packages/cloud",
    "packages/cloud/src",
    "packages/cloud/src/cli",
    "packages/cloud/src/cli/admin",
    "packages/example",
    "packages/example/src",
  ];
  const cli = join(root, "packages/cloud/src/cli/admin/settings.ts");
  const config = join(root, "packages/example/src/config.ts");
  try {
    for (const dir of dirs) await mkdir(join(root, dir));
    await writeFile(cli, 'command("settings set", {});');
    await writeFile(config, 'export const settings = { "example.enabled": { kind: "boolean", default: true } };');
    const context = { workspaceRoot: root, fix: false, flags: new Set<string>() };
    expect(await rule.run(context)).toEqual([expect.objectContaining({ message: expect.stringContaining("example.enabled") })]);
    await writeFile(cli, 'command("settings set", {});\n  example: "/api/example/admin/settings/",');
    expect(await rule.run(context)).toEqual([]);
    await writeFile(
      config,
      'export const settings = { "example.enabled": { kind: "boolean", default: true, envFallback: "EXAMPLE", adminWrite: "application" } };',
    );
    expect(await rule.run(context)).toHaveLength(1);
    await writeFile(config, 'export const settings = { "foreign.enabled": { kind: "boolean", default: true } };');
    expect(await rule.run(context)).toHaveLength(1);
    await writeFile(config, 'export const settings = { "example.enabled": { kind: "boolean", default: true } };');
    await writeFile(cli, '  example: "/api/example/admin/settings/",');
    expect(await rule.run(context)).toHaveLength(1);
  } finally {
    for (const file of [cli, config]) await unlink(file);
    for (const dir of dirs.toReversed()) await rmdir(join(root, dir));
    await rmdir(root);
  }
});
