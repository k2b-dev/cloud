import { expect, test } from "bun:test";
import { checkTestNativeCompilersSource } from "./test-native-compilers";

const check = (source: string) => checkTestNativeCompilersSource("fixture.test.ts", source).map(({ line }) => line);

test("rejects native compilers in hooks, tests and test-local setup helpers", () => {
  expect(
    check(`beforeAll(async () => {
  Bun.spawn(["cc", "-O2", "fixture.c"]);
});
test("native", () => spawnSync("/usr/bin/clang++", ["fixture.cc"]));
async function setup() { execFile("aarch64-linux-gnu-gcc-14", ["fixture.c"]); }
afterAll(function () { Bun.spawn({ cmd: ["rustc", "fixture.rs"] }); });
`),
  ).toEqual([2, 4, 5, 6]);
});

test("accepts module-level compilation and ignores comments and source strings", () => {
  expect(
    check(`const launcher = Bun.spawn(["cc", "fixture.c"]);
// beforeAll(() => Bun.spawn(["cc", "fixture.c"]));
const source = 'test("native", () => Bun.spawn(["cc", "fixture.c"]))';
beforeAll(() => Bun.spawn(["bun", "fixture.ts"]));
`),
  ).toEqual([]);
});

test("checks compiler families, shell commands and multiline Bun commands", () => {
  expect(
    check(`test("native", () => {
  execSync("gcc -O2 fixture.c");
  Bun.spawnSync([
    "g++", "fixture.cc"
  ]);
  execFileSync("zig", ["cc", "fixture.c"]);
  spawn("clang-19", ["fixture.c"]);
});`),
  ).toEqual([2, 3, 6, 7]);
});
