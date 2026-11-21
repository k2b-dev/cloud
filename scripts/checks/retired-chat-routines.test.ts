import { expect, test } from "bun:test";
import { retiredRoutineImports } from "./retired-chat-routines";

test("blocks retired runtime, UI and authority imports through every module form", () => {
  const source = [
    'import { aiChatTasks } from "./chat-tasks";',
    'export * from "./ai-chat-tasks-runtime";',
    'const dialog = import("../frontend/AssistantTasksDialog");',
    'const review = require("./background-review.ts");',
    "const formatting = import(`./scheduled-task-format`);",
    'const entry = Bun.file("./chat-task-contracts.ts");',
    'const worker = new URL("./ai-chat-tasks-runtime.ts", import.meta.url);',
  ].join("\n");
  expect(retiredRoutineImports("fixture.ts", source).map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("retains shared AI tasks, Code scheduling and read-only archive projections", () => {
  expect(
    retiredRoutineImports(
      "fixture.ts",
      [
        'import { runApplicationAiTask } from "./application-tasks";',
        'import { startCodeScheduling } from "./code/scheduling-runtime";',
        'import { retireChatTaskSchedules } from "./retired-chat-routines";',
        'import { assertInteractiveChatTurn } from "./retired-routines";',
        'import { exportChatTasks } from "./chat-task-export";',
        'import { aiChatTaskExportRoutes } from "./ai-chat-task-export-routes";',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("blocks the retired chat host policy without banning other host policies", () => {
  expect(retiredRoutineImports("packages/assistant/src/chat-code/host-fetch.ts", 'import "./host-policy";')).toHaveLength(1);
  expect(retiredRoutineImports("fixture.ts", 'import "./chat-code/host-policy";')).toHaveLength(1);
  expect(retiredRoutineImports("fixture.ts", 'import "./host-policy";')).toEqual([]);
});
