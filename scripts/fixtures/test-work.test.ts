import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["modifiers", "only"])("observed registrations preserve native %s behavior", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-test-work-"));
  try {
    await writeFile(
      join(directory, "observe.ts"),
      `import { observeTestWork } from ${JSON.stringify(join(import.meta.dir, "test-work.ts"))};
observeTestWork();`,
    );
    await writeFile(
      join(directory, "registrations.test.ts"),
      `import { afterAll, expect, it, test } from "bun:test";
const ran = [];
const unexpected = () => { throw new Error("excluded callback ran"); };
if (process.env.REGISTRATION_CASE === "only") {
  test("not selected", unexpected);
  test.only("only", () => { ran.push("only"); });
  it.only.each([7])("only each %i", value => { expect(value).toBe(7); ran.push("only each"); });
} else {
  test.skip("skip", unexpected);
  it.skip("it skip", unexpected);
  test.todo("todo", unexpected);
  test.if(false)("if false", unexpected);
  test.skipIf(true)("skipIf true", unexpected);
  test.skip.each([1])("skip each %i", unexpected);
  test.if(true)("if true", async () => { ran.push("if"); });
  test.skipIf(false)("skipIf false", () => { ran.push("skipIf"); });
  test.each([[1, 2], [3, 4]])("each %i %i", (first, second) => {
    expect(second).toBe(first + 1); ran.push("each " + first);
  });
  it.each([7])("it each %i", value => { expect(value).toBe(7); ran.push("it each"); });
  test.failing("failing", async () => { ran.push("failing"); throw new Error("expected failure"); });
}
afterAll(() => console.log("ran:" + ran.sort().join(",")));
`,
    );
    const outputs: string[] = [];
    for (const observed of [false, true]) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "test", ...(observed ? ["--preload", "./observe.ts"] : []), "registrations.test.ts"],
        {
          cwd: directory,
          env: { PATH: process.env.PATH, BUN_OPTIONS: "--no-env-file", REGISTRATION_CASE: mode },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = stdout + stderr;
      expect(code, output).toBe(0);
      expect(output).not.toContain("ScopeFunctions");
      expect(output).toContain(mode === "only" ? "ran:only,only each" : "ran:each 1,each 3,failing,if,it each,skipIf");
      outputs.push(output);
    }
    const counts = (output: string) => output.match(/\b\d+ (?:pass|skip|todo|fail)\b/g);
    const [unobserved = "", observed = ""] = outputs;
    expect(counts(observed)).toEqual(counts(unobserved));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
