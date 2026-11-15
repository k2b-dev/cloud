import { expect, test } from "bun:test";
import { finishedPlanShown, taskHostOpen } from "./task-host";

test("the plan is open while Gustav works on it and folds once every task is done", () => {
  expect(taskHostOpen({ hasOpenTasks: true, choice: null })).toBe(true);
  expect(taskHostOpen({ hasOpenTasks: false, choice: null })).toBe(false);
});

test("the person's own choice wins in both directions", () => {
  expect(taskHostOpen({ hasOpenTasks: true, choice: "closed" })).toBe(false);
  expect(taskHostOpen({ hasOpenTasks: false, choice: "open" })).toBe(true);
  expect(taskHostOpen({ hasOpenTasks: false, choice: "closed" })).toBe(false);
});

test("a finished plan keeps its header when it finished here or the person opened it, not when it was done before", () => {
  expect(finishedPlanShown({ finishedHere: true, choice: null })).toBe(true);
  expect(finishedPlanShown({ finishedHere: false, choice: "open" })).toBe(true);
  expect(finishedPlanShown({ finishedHere: false, choice: null })).toBe(false);
  expect(finishedPlanShown({ finishedHere: false, choice: "closed" })).toBe(false);
});
