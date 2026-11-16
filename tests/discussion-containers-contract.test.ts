import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appIds, workspaceRoot } from "../scripts/workspace";

// The platform rejects a discussion containers page whose `page` disagrees with `data.next`, but application tests
// call `run` directly and never pass that check. Every provider therefore asserts the same contract in its own tests.
const sources = (appId: string, tests: boolean) =>
  [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: join(workspaceRoot, "packages", appId) })]
    .filter((file) => /\.test\.tsx?$/.test(file) === tests)
    .map((file) => readFileSync(join(workspaceRoot, "packages", appId, file), "utf8"));

test("every discussion provider asserts that its containers page matches data.next", () => {
  const providers = appIds().filter((appId) => sources(appId, false).some((source) => /\bdiscussions:\s*\{\s*item:/.test(source)));
  expect(providers).toEqual(expect.arrayContaining(["contacts", "filesv2", "grids", "notebooks", "spaces"]));
  const missing = providers.filter((appId) => !sources(appId, true).some((source) => source.includes("assertDiscussionContainersPage(")));
  expect(missing).toEqual([]);
});
