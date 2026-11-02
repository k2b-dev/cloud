import { expect, test } from "bun:test";
import { targetKey } from "./activation-plan";
import { attributeMissingTargets } from "./automations";

const space = { type: "spaces.space", id: "sp_2lg8" };
const removed = new Set([targetKey(space)]);
const automation = (entrypoint: string, lastRunState: string | null) => ({
  entrypoint,
  lastRunState,
  lastRunId: lastRunState ? `run-${entrypoint}` : null,
  missing: [] as string[],
});

test("nothing removed: no automation lacks access and no calls are read", async () => {
  const automations = [automation("sort", "failed")];
  await attributeMissingTargets(automations, new Set(), "editor", () => {
    throw new Error("must not read calls");
  });
  expect(automations[0]!.missing).toEqual([]);
});

test("a failed last run that called the target names that automation; the other keeps running", async () => {
  const automations = [automation("sort", "succeeded"), automation("deliver", "failed")];
  await attributeMissingTargets(automations, removed, "editor", async (runId) =>
    runId === "run-deliver" ? [{ capability: "spaces.task.create", target: space }] : [],
  );
  expect(automations.map((item) => item.missing.length)).toEqual([0, 1]);
});

test("additional references count, and a failed run elsewhere names nothing", async () => {
  const automations = [automation("a", "failed"), automation("b", "failed")];
  await attributeMissingTargets(automations, removed, "editor", async (runId) =>
    runId === "run-a"
      ? [{ capability: "tasks.create", target: { type: "tasks.list", id: "l1" }, refs: { space } }]
      : [{ capability: "tasks.create", target: { type: "tasks.list", id: "l1" } }],
  );
  expect(automations.map((item) => item.missing.length)).toEqual([1, 0]);
});

test("the only automation needs the access in any case, also for a reader who gets no calls", async () => {
  const automations = [automation("sort", "failed")];
  await attributeMissingTargets(automations, removed, "reader", () => {
    throw new Error("readers get no call contents");
  });
  expect(automations[0]!.missing).toEqual([targetKey(space)]);
});

test("a reader of several automations learns nothing about which one, and unreadable calls name nothing", async () => {
  const forReader = [automation("a", "failed"), automation("b", "succeeded")];
  await attributeMissingTargets(forReader, removed, "reader", () => {
    throw new Error("readers get no call contents");
  });
  expect(forReader.map((item) => item.missing)).toEqual([[], []]);
  const failing = [automation("a", "failed"), automation("b", "failed")];
  await attributeMissingTargets(failing, removed, "editor", () => Promise.reject(new Error("database down")));
  expect(failing.map((item) => item.missing)).toEqual([[], []]);
});

test("at most three failed automations are read, one after another", async () => {
  const automations = ["a", "b", "c", "d"].map((name) => automation(name, "failed"));
  const read: string[] = [];
  await attributeMissingTargets(automations, removed, "editor", async (runId) => {
    read.push(runId);
    return [];
  });
  expect(read).toEqual(["run-a", "run-b", "run-c"]);
});

test("an app-wide call stores no target and names its app", async () => {
  const automations = [automation("a", "failed"), automation("b", "failed")];
  const app = targetKey({ type: "app", id: "weather" });
  await attributeMissingTargets(automations, new Set([app]), "editor", async (runId) =>
    runId === "run-a" ? [{ capability: "weather.forecast.read", target: null }] : [],
  );
  expect(automations.map((item) => item.missing)).toEqual([[app], []]);
});
