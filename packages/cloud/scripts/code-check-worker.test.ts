import { expect, test } from "bun:test";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, type CodeVersionManifest } from "../src/code/checker-contract";
import { generateCodeSdk } from "../src/code/generator";

async function bundle(source: string, entrypoints: CodeVersionManifest["entrypoints"], codeRun = false) {
  const request: CodeCheckRequest & { entrypoints: CodeVersionManifest["entrypoints"] } = {
    files: { "code.ts": source },
    entry: "code.ts",
    aiOperations: [],
    sdk: generateCodeSdk([], { mode: codeRun ? "code_run" : "personal" }),
    entrypoints,
    limits: CODE_CHECK_LIMITS,
  };
  const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/code-check-worker.ts`, "bundle", "/dev/stdin"], {
    stdin: new TextEncoder().encode(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result: { bundle: string; modules: string[] } = JSON.parse(stdout);
    expect(result.modules).toEqual(["code.ts"]);
    return import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

test("worker preserves arbitrary ESM export labels as string data", async () => {
  const entrypoint = 'label"; throw new Error("unexpected label"); // ` ${value}\n*/';
  const module = await bundle(
    "export default (input: string) => input;",
    [{ kind: "manual", entrypoint, cron: null, file: "code.ts", line: 1 }],
    true,
  );
  expect(Object.keys(module)).toEqual([entrypoint]);
  expect(await module[entrypoint]("returned", { call() {} })).toBe("returned");
});

test("worker preserves quoted schedule metadata and the registration guard", async () => {
  const title = 'A "quote" ` ${price} */';
  const entries: CodeVersionManifest["entrypoints"] = [
    { kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1", title, file: "code.ts", line: 1 },
  ];
  const source = [
    'import { app } from "@sdk";',
    'app.schedule("0 8 * * 1", () => "finished", { name: "weekly", title: \'A "quote" ` ${price} */\' });',
  ].join("\n");
  const module = await bundle(source, entries);
  expect(await module.weekly(undefined, { call() {} })).toBe("finished");
  const changed = await bundle(
    source,
    entries.map((entry) => ({ ...entry, title: "Different" })),
  );
  await expect(changed.weekly(undefined, { call() {} })).rejects.toThrow("code_entrypoints_changed");
});
