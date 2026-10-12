import { expect, test } from "bun:test";
import { isCommandPath } from "./command-path";
import { CommandPathSchema } from "./commands";

const paths: [string, boolean][] = [
  ["/", true],
  ["/app/mail?draft=1#body", true],
  ["/app/files//nested", true],
  ["/app/../mail", true],
  ["/app/%20mail", true],
  [`/${"x".repeat(1999)}`, true],
  [`/${"x".repeat(2000)}`, false],
  [`/${"🙂".repeat(999)}`, true],
  [`/${"🙂".repeat(1000)}`, true],
  [`/${"🙂".repeat(1999)}`, true],
  [`/${"🙂".repeat(2000)}`, false],
  [`/app/demo?q=${"🙂".repeat(999)}`, true],
  [`/${"\uD83D".repeat(2000)}`, false],
  ["", false],
  ["app/mail", false],
  ["../mail", false],
  ["//host", false],
  ["///host", false],
  ["/\\host", false],
  ["/app\\mail", false],
  ["/app/ mail", false],
  ["/.//host/x", false],
  ["/%2e//host", false],
  ["/app/..//host", false],
  ["https://cloud.invalid/app/mail", false],
  ["https://other.test/app/mail", false],
  ["javascript:alert(1)", false],
];
for (let code = 0; code <= 0x20; code++) paths.push([`/app/${String.fromCharCode(code)}mail`, false]);

test.each(paths)("command paths match the schema: %j", (path, accepted) => {
  expect(isCommandPath(path)).toBe(accepted);
  expect(isCommandPath(path)).toBe(CommandPathSchema.safeParse(path).success);
});

test("overlong command paths keep their existing size and syntax errors", () => {
  const validPath = CommandPathSchema.safeParse(`/${"x".repeat(2000)}`);
  const invalidPath = CommandPathSchema.safeParse(`//${"x".repeat(2000)}`);
  expect(validPath.success).toBe(false);
  expect(invalidPath.success).toBe(false);
  if (!validPath.success && !invalidPath.success) {
    expect(validPath.error.issues.map((issue) => issue.code)).toEqual(["too_big"]);
    expect(invalidPath.error.issues.map((issue) => issue.code)).toEqual(["too_big", "custom"]);
    expect(invalidPath.error.issues[1]?.message).toBe("Expected a Cloud path");
  }
});
