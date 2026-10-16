import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const fixture = join(import.meta.dir, "echo-plugin");
const packScript = resolve(import.meta.dir, "../../../cloud/scripts/cli-pack.ts");

const pack = async (cwd: string, entry: string, references: string, target: string): Promise<string> => {
  const child = Bun.spawn([process.execPath, "run", packScript, entry, "--references", references, "--out", target], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Failed to pack plugin fixture: ${stdout}${stderr}`);
  return target;
};

/** Exercise the actual author entry point, including bundled dependencies and references. */
export const buildEchoPlugin = (target: string): Promise<string> => pack(fixture, "src/cli.ts", "references", target);

/** Pack a small inline module with the same script used by package authors. */
export const packInlinePlugin = async (target: string, source: string, name = "test-plugin", version = "1.0.0"): Promise<string> => {
  const cwd = `${target}-source`;
  await mkdir(join(cwd, "references"), { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name, version, type: "module" }));
  await writeFile(join(cwd, "module.ts"), source);
  await writeFile(join(cwd, "references", "index.md"), `# ${name}\n`);
  return pack(cwd, "module.ts", "references", target);
};
