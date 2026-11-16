import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { backgroundWorkFindings, rule } from "./background-work";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-background-work-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/example", "packages/gateway", "packages/cloud"] } }),
    );
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a timer with a reason, the platform interval and comments pass", () => {
  const source = [
    "// runtime-timer: lease heartbeat of work already in flight.",
    "const lease = setInterval(() => void extend(), 10_000);",
    "const sweep = startRuntimeInterval({ run, intervalMs: 30_000, onError });",
    " * setInterval(() => sweep()) in a comment",
    "const live = setInterval(ping, 5_000); // runtime-timer: serves open live connections.",
  ].join("\n");
  expect(backgroundWorkFindings(source)).toEqual([]);
});

test("a raw timer, a marker without a reason, and a second Sync are reported", () => {
  const source = [
    "const timer = setInterval(() => void recover(), 30_000);",
    "// runtime-timer:",
    "const other = setInterval(scan, 1_000);",
    'const sync = createSync({ connection, namespace, application: "example" });',
  ].join("\n");
  expect(backgroundWorkFindings(source)).toEqual([
    { line: 1, kind: "timer" },
    { line: 3, kind: "timer" },
    { line: 4, kind: "sync" },
  ]);
  expect(backgroundWorkFindings(source, { allowCreateSync: true })).toEqual([
    { line: 1, kind: "timer" },
    { line: 3, kind: "timer" },
  ]);
});

test("only server code of quiescing packages is in scope", async () => {
  const timer = "setInterval(() => void scan(), 1_000);\n";
  expect(
    await findings({
      "packages/example/src/service/runtime.ts": timer,
      "packages/example/src/frontend/Clock.ts": timer,
      "packages/example/src/service/runtime.test.ts": timer,
      "packages/example/src/Widget.tsx": timer,
      "packages/gateway/src/runtime.ts": timer,
      "packages/cloud/src/_internal/process-sync.ts": "sync = createSync({ connection });\n",
      "packages/example/src/own-sync.ts": "const sync = createSync({ connection });\n",
    }),
  ).toEqual(["packages/example/src/own-sync.ts:1", "packages/example/src/service/runtime.ts:1"]);
});
