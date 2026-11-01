import { expect, test } from "bun:test";
import { automationsAt } from "./target-access";

const manifest = {
  permissions: [
    { operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_2lg8" }, entrypoints: ["lieferungenEintragen"] },
    { operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_other" }, entrypoints: ["anderswo"] },
    { operation: "spaces.task.list", target: { type: "spaces.space", id: "sp_2lg8" } },
    // App-wide: the checker writes no target, activation grants it at { type: "app", id: "weather" }.
    { operation: "weather.forecast.read", target: null, entrypoints: ["morgens"] },
  ],
};

test("a grant names the automations whose calls use its operations at exactly its target", () => {
  expect(automationsAt(manifest, { type: "spaces.space", id: "sp_2lg8" }, ["spaces.task.create", "spaces.task.list"])).toEqual([
    "lieferungenEintragen",
  ]);
  expect(automationsAt(manifest, { type: "app", id: "weather" }, ["weather.forecast.read"])).toEqual(["morgens"]);
  expect(automationsAt(manifest, { type: "spaces.space", id: "sp_2lg8" }, ["spaces.task.list"])).toEqual([]);
  expect(automationsAt(null, { type: "spaces.space", id: "sp_2lg8" }, ["spaces.task.create"])).toEqual([]);
});
