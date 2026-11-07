import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource } from "./workflow-boundaries";

const root = resolve(".");
const ai = resolve(root, "packages/cloud/src/ai/application-tasks.ts");

test.each([
  'import { task } from "../workflows/ai/store";',
  'import type { Task } from "../workflows/contracts";',
  'export * from "../workflows/ai/runtime";',
  'const tasks = import("../workflows/ai/runtime");',
  "const tasks = import(`../workflows/ai/runtime`);",
  'const tasks = require("../workflows/ai/runtime");',
  'import tasks = require("../workflows/ai/runtime");',
  'type Task = import("../workflows/contracts").Task;',
  'import { task } from "@k2b/cloud/workflows/ai";',
  'import "packages/cloud/src/workflows/ai/store";',
])("rejects dependencies on the engine: %s", (source) => {
  expect(checkSource(ai, source, root)).toHaveLength(1);
});

test("rejects absolute and normalized relative paths", () => {
  expect(checkSource(ai, `import "${root}/packages/cloud/src/workflows/ai/store";`, root)).toHaveLength(1);
  expect(checkSource(ai, 'import "./tasks/../../workflows/ai/store";', root)).toHaveLength(1);
});

test.each(["commands.ts", "command-runtime.ts", "conversation-summary-ai.ts"])(
  "retained Mail %s cannot directly import the engine",
  (name) => {
    expect(checkSource(resolve(root, "packages/mail/src/service", name), 'import "@k2b/cloud/workflows/store";', root)).toHaveLength(1);
  },
);

test("allows neutral helpers and ignores ordinary strings", () => {
  expect(checkSource(ai, 'import "./tasks/store"; const description = "../workflows/ai/store";', root)).toEqual([]);
  expect(checkSource(ai, 'import "@k2b/cloud/ai/tasks";', root)).toEqual([]);
});

test.each([
  "packages/cloud/src/workflows/ai/store.ts",
  "packages/cloud/src/ai/application-tasks.test.ts",
  "packages/cloud/src/ai/model-delete.ts",
  "packages/mail/src/service/workflow-runtime.ts",
])("allows the existing workflow integration in %s", (file) => {
  expect(checkSource(resolve(root, file), 'import "@k2b/cloud/workflows/ai";', root)).toEqual([]);
});
