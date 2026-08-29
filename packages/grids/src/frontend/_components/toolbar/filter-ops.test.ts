import { describe, expect, test } from "bun:test";
import { localizedOpsForType, opsForType } from "./filter-ops";

describe("principal filter operations", () => {
  test("offers identity membership and emptiness without text operators", () => {
    expect(opsForType("principal").map((operation) => operation.id)).toEqual(["containsAny", "notContainsAny", "isEmpty", "isNotEmpty"]);
  });

  test("keeps operation ids stable while localizing rendered labels", () => {
    expect(localizedOpsForType("principal", "de-CH").map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "containsAny", label: "enthält" },
      { id: "notContainsAny", label: "enthält nicht" },
      { id: "isEmpty", label: "leer" },
      { id: "isNotEmpty", label: "nicht leer" },
    ]);
  });
});
