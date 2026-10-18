import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkTestWaitsSource, formatBaseline, rule } from "./test-waits";

const file = "packages/demo/src/view.test.ts";
const baseline = "scripts/checks/test-waits.baseline";
const check = (source: string) => checkTestWaitsSource(file, source).map(({ line }) => line);

test("finds directly awaited sleeps with numeric literals at least one second", () => {
  expect(check("await Bun.sleep(1000); await sleep(2_000);\nawait Bun . sleep (\n  1_000,\n); ")).toEqual([1, 1, 2]);
});

test("accepts other numeric literal forms and keeps the one-second threshold", () => {
  expect(check("await sleep(1e3); await Bun.sleep(1_000.5); await sleep(0x3e8); await sleep(0b1111101000); await sleep(0o1750);")).toEqual([
    1, 1, 1, 1, 1,
  ]);
  expect(check("await sleep(999.9); await sleep(9e2); await sleep(0x3e7);")).toEqual([]);
});

test("finds awaited timer promises, including typed promises, browser timers and nested callbacks", () => {
  expect(
    check(`await new Promise(resolve => setTimeout(resolve, 1000));
await new Promise<void>((resolve) => { setTimeout(() => resolve(), 2_000); });
await new Promise((resolve) => window.setTimeout(resolve, 1_000));
await new Promise(resolve => dom.window.setTimeout(() => { log(1, nested(2)); resolve(); }, 3_000));
await new Promise(resolve => setTimeout(resolve, 1000, extra));
await new Promise(function (resolve) { setTimeout(function () { resolve(); }, 1_000); });
await new Promise((r) => setTimeout(r, 1500));
`),
  ).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("ignores an event wait with a rejecting watchdog", () => {
  expect(
    check(`await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error("Chat socket did not open"));
  }, 3_000);
  socket.onopen = () => {
    clearTimeout(timer);
    resolve();
  };
  socket.onerror = () => {
    clearTimeout(timer);
    socket.close();
    reject(new Error("Chat socket failed"));
  };
});`),
  ).toEqual([]);
});

test("ignores timers whose callbacks do not reference the resolve parameter", () => {
  expect(
    check(`await new Promise((resolve, reject) => setTimeout(reject, 3_000));
await new Promise((resolve, reject) => setTimeout(() => reject(new Error("Timeout")), 3_000));
await new Promise(r => setTimeout(() => other(), 3_000));
await new Promise(resolve => setTimeout(() => resolveLater(), 3_000));`),
  ).toEqual([]);
});

test("ignores a fallback timer when an event also resolves the promise", () => {
  expect(
    check(`await new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), 3_000);
  socket.onmessage = event => {
    clearTimeout(timer);
    resolve(event.data);
  };
});`),
  ).toEqual([]);
});

test("ignores promises without a named first executor parameter", () => {
  expect(
    check(`await new Promise(() => setTimeout(callback, 3_000));
await new Promise(function () { setTimeout(() => done(), 3_000); });`),
  ).toEqual([]);
});

test("ignores comments and string or template contents, including child-process scripts", () => {
  expect(
    check(`// await Bun.sleep(1000)
/* await sleep(1000)
   await new Promise(resolve => setTimeout(resolve, 1000)); */
const script = "await Bun.sleep(1000); // fixed wait: string";
const other = 'await sleep(1000); /*';
const child = \`await new Promise(resolve => window.setTimeout(resolve, 1000));\`;
await /* comment */ Bun.sleep(1000); // quoted markers do not hide this
`),
  ).toEqual([7]);
  expect(check(String.raw`"escaped \" await sleep(1000)"; 'escaped \' await Bun.sleep(1000)';`)).toEqual([]);
});

test("ignores bounds, non-awaited calls, short waits and non-literal durations", () => {
  expect(
    check(`await Promise.race([client.exited, Bun.sleep(20_000)]);
await Promise.race([event, new Promise(resolve => setTimeout(resolve, 1000))]);
Bun.sleep(1000); sleep(2000); new Promise(resolve => setTimeout(resolve, 1000));
await Bun.sleep(999); await sleep(0);
await sleep(delay); await Bun.sleep(500 * 3); await sleep(1000 + extra);
await new Promise(resolve => setTimeout(resolve, duration));
await new Promise(resolve => setTimeout(resolve, 999));
await new Promise(resolve => start(resolve));
setTimeout(callback, 1000);
`),
  ).toEqual([]);
});

test("accepts a non-empty fixed-wait reason only in a line comment on this or the preceding line", () => {
  expect(
    check(`await sleep(1000); // fixed wait: exercises the rate-limit window
// fixed wait: tests timeout expiry
await new Promise(resolve => setTimeout(resolve, 1000));
await Bun.sleep(1000);
// fixed wait:
await sleep(1000); // fixed wait:${"   "}
/* fixed wait: a block comment is not an opt-out */
await sleep(1000);
const reason = "// fixed wait: a string is not a comment"; await sleep(1000);
// fixed wait: too far away

await sleep(1000);
`),
  ).toEqual([4, 6, 8, 9, 12]);
});

const workspace = async (files: Record<string, string>, counts?: ReadonlyMap<string, number>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-waits-"));
  if (counts) files[baseline] = formatBaseline(counts);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const run = (fix = false) => rule.run({ workspaceRoot: root, fix, flags: new Set() });
  const locations = async (fix = false) =>
    (await run(fix)).map((finding) => `${relative(root, finding.file!)}${finding.line ? `:${finding.line}` : ""}`);
  return { root, run, locations };
};

test("scopes test files across every source root and skips dependencies and build outputs", async () => {
  const included = [file, "packages/demo/view.test.tsx", "pwas/demo/view.test.ts", "docs-site/src/view.test.tsx", "scripts/demo.test.ts"];
  const excluded = [
    "packages/demo/view.ts",
    "packages/demo/view.spec.ts",
    "packages/demo/view.test.js",
    "packages/demo/browser-harness.ts",
    "packages/demo/node_modules/dependency/view.test.ts",
    "packages/demo/dist/view.test.ts",
    "other/view.test.ts",
  ];
  const { root, locations } = await workspace(Object.fromEntries([...included, ...excluded].map((path) => [path, "await sleep(1000);"])));
  try {
    expect(await locations()).toEqual(included.sort().map((path) => `${path}:1`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an excess reports every finding in that file and fix never raises its count", async () => {
  const counts = new Map([[file, 1]]);
  const { root, locations } = await workspace({ [file]: "await Bun.sleep(1000);" }, counts);
  try {
    expect(await locations()).toEqual([]);
    await writeFile(join(root, file), "await Bun.sleep(1000);\nawait sleep(2000);");
    expect(await locations()).toEqual([`${file}:1`, `${file}:2`]);
    expect(await locations(true)).toEqual([`${file}:1`, `${file}:2`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lower counts fail until fix lowers them and removes empty or missing entries", async () => {
  const empty = "packages/demo/empty.test.ts";
  const missing = "pwas/demo/missing.test.ts";
  const counts = new Map([
    [file, 2],
    [empty, 1],
    [missing, 1],
  ]);
  const { root, run, locations } = await workspace({ [file]: "await Bun.sleep(1000);", [empty]: "await Bun.sleep(20);" }, counts);
  try {
    const findings = await run();
    expect(findings).toHaveLength(3);
    expect(findings.every(({ message }) => message.includes("lower/remove the entry"))).toBe(true);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
    expect(await locations(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[file, 1]])));
    expect(await locations()).toEqual([]);
    await writeFile(join(root, file), "// fixed");
    expect(await locations()).toEqual([baseline]);
    expect(await locations(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fix lowers known counts without adding a new file or hiding its findings", async () => {
  const other = "packages/demo/other.test.ts";
  const { root, locations } = await workspace({ [file]: "await Bun.sleep(1000);", [other]: "await sleep(2000);" }, new Map([[file, 2]]));
  try {
    expect(await locations(true)).toEqual([`${other}:1`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[file, 1]])));
    expect(await locations()).toEqual([`${other}:1`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
