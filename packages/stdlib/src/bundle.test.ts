import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Guard against the root barrel leaking back into an i18n-only bundle.
const I18N_ONLY_BUDGET_BYTES = 4 * 1024;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "stdlib-bundle-"));
  const scopeDir = join(tempDir, "node_modules", "@k2b");
  await mkdir(scopeDir, { recursive: true });
  await symlink(repoRoot, join(scopeDir, "stdlib"), "dir");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const bundle = async (name: string, source: string): Promise<string> => {
  const file = join(tempDir, `${name}.ts`);
  await writeFile(file, source);
  const result = await Bun.build({
    entrypoints: [file],
    target: "browser",
    minify: true,
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  if (result.outputs.length !== 1) {
    throw new Error(`Expected one bundle output, got ${result.outputs.length}`);
  }
  return await result.outputs[0]!.text();
};

const runBundle = async (name: string, code: string) => {
  const file = join(tempDir, `${name}.js`);
  await writeFile(file, code);
  const child = Bun.spawn([process.execPath, file], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout };
};

describe("consumer bundles", () => {
  it("importing i18n from the root leaves dayjs and big.js out", async () => {
    const code = await bundle("i18n", 'import { i18n } from "@k2b/stdlib";\nconsole.log(i18n);');
    expect(new TextEncoder().encode(code).length).toBeLessThanOrEqual(I18N_ONLY_BUDGET_BYTES);
    expect(code).not.toContain("$isDayjsObject");
    expect(code).not.toContain("Invalid Date");
    expect(code).not.toContain("[big.js]");
  });

  it("a root date helper still registers the dayjs timezone plugins in a bundle", async () => {
    const code = await bundle("dates", `
      import { startOfDay } from "@k2b/stdlib";
      console.log(startOfDay("2026-03-29T12:00:00Z", {
        timeZone: "Europe/Berlin",
      }).toISOString());
    `);
    expect(code).toContain("$isDayjsObject");
    const result = await runBundle("dates", code);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2026-03-28T23:00:00.000Z\n");
  });

  it("a root money helper still bundles and runs", async () => {
    const code = await bundle("money", `
      import { moneyFromDecimal } from "@k2b/stdlib";
      console.log(moneyFromDecimal("1234.567", { currency: "KWD" }).amount);
    `);
    const result = await runBundle("money", code);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1234567\n");
  });
});
